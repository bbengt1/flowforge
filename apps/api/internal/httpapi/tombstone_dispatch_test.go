package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestTombstoneIngressAndSchedulerStayStopped(t *testing.T) {
	var frozen atomic.Int64
	base := time.Now().UTC().Add(time.Second)
	frozen.Store(base.UnixNano())
	now := func() time.Time { return time.Unix(0, frozen.Load()).UTC() }

	idStore := identity.NewMemory()
	workflows := wfstore.NewMemory()
	schedules := schedule.NewMemory()
	ops := opsconfig.NewMemory()
	hooks := webhook.NewMemory()
	keys := vault.TestKeys()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:         idStore,
		Scoped:        isolation.NewMemory(),
		Sessions:      session.NewMemory(),
		Workflows:     workflows,
		Schedules:     schedules,
		Ops:           ops,
		Hooks:         hooks,
		Vault:         vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:          keys,
		Approvals:     approval.NewMemory(),
		Now:           now,
		JobBindingKey: wfstore.NewJobBindingKey(),
	}))
	api, ok := h.(*API)
	if !ok {
		t.Fatal("API handler must expose scheduler ticks")
	}
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	ws, tenant := currentWorkspace(t, h, admin)
	scope, err := isolation.AuthorizeTenancy(ws.ID, admin.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}

	created := createWorkflow(t, h, admin, tenant, ws, typedWebhookYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "tomb")
	cred := createVaultCredential(t, h, admin, tenant, ws, "webhook_secret", "Hook", map[string]string{"secret": webhookSecretPlain})
	trig := createWebhookTrigger(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID, cred.ID, nil)
	body := []byte(`{"workflowId":"` + created.Workflow.ID + `","workflowVersionId":"` + pub.Version.ID + `","timezone":"UTC","interval":"PT15M"}`)
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("schedule: %d %s", rec.Code, rec.Body.String())
	}
	var sched schedule.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &sched); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+created.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}

	if _, err := hooks.SetStatus(context.Background(), scope, trig.ID, webhook.StatusEnabled); err != nil {
		t.Fatal(err)
	}
	if _, err := schedules.SetStatus(context.Background(), scope, now(), sched.ID, schedule.StatusEnabled); err != nil {
		t.Fatal(err)
	}
	frozen.Store(base.Add(16 * time.Minute).UnixNano())

	ts := strconv.FormatInt(now().Unix(), 10)
	rec = httptest.NewRecorder()
	req = signedHook(trig.PublicID, ts, "v1="+strings.Repeat("ab", 32), []byte(`{"env":"prod"}`))
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	if err := api.TickDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := api.TickDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := schedules.Get(context.Background(), scope, sched.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != schedule.StatusDisabled {
		t.Fatalf("schedule status = %s", got.Status)
	}
	if got.LastError == "not found" || got.LastError == "workflow was deleted" {
		t.Fatalf("last_error = %q", got.LastError)
	}
}
