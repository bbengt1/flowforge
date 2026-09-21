package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
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

func TestSchedulerTicksDispatchRecoverPurgeAndSkipsDrafts(t *testing.T) {
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
	jobKey := wfstore.NewJobBindingKey()
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
		JobBindingKey: jobKey,
		Approvals:     approval.NewMemory(),
		Now:           now,
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
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}
	ws, tenant := currentWorkspace(t, h, admin)
	scope, err := isolation.AuthorizeTenancy(ws.ID, admin.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}

	created := createWorkflow(t, h, admin, tenant, ws, scheduleYAML)
	// Pin a schedule at a version that was never published. The tick must
	// not start it — drafts never run.
	if _, err := schedules.Create(context.Background(), scope, now(), schedule.CreateInput{
		WorkflowID:        created.Workflow.ID,
		WorkflowVersionID: "00000000-0000-4000-8000-0000000000aa",
		Timezone:          "UTC",
		Interval:          "PT1M",
	}); err != nil {
		t.Fatal(err)
	}
	frozen.Store(base.Add(2 * time.Minute).UnixNano())
	if err := api.TickDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	execs, err := workflows.ListExecutions(context.Background(), scope, wfstore.ExecutionListFilter{WorkflowID: created.Workflow.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(execs) != 0 {
		t.Fatalf("unpublished schedule started %d executions", len(execs))
	}

	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "sched-tick")
	body, _ := json.Marshal(map[string]any{
		"workflowId":        created.Workflow.ID,
		"workflowVersionId": pub.Version.ID,
		"timezone":          "UTC",
		"interval":          "PT1M",
		"overlapPolicy":     "skip",
		"catchUp":           0,
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create schedule: %d %s", rec.Code, rec.Body.String())
	}
	frozen.Store(base.Add(4 * time.Minute).UnixNano())
	if err := api.TickDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	execs, err = workflows.ListExecutions(context.Background(), scope, wfstore.ExecutionListFilter{WorkflowID: created.Workflow.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(execs) != 1 || execs[0].WorkflowVersionID != pub.Version.ID {
		t.Fatalf("published tick executions = %+v", execs)
	}
	if execs[0].PolicySnapshot["triggerType"] != schedule.TypeSchedule {
		t.Fatalf("trigger = %+v", execs[0].PolicySnapshot)
	}

	claimBody, _ := json.Marshal(map[string]any{"workerId": "worker-a", "leaseSeconds": 1})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", claimBody, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}
	var claimed claimJobResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if _, err := wfstore.ParseJobTicket(jobKey, claimed.JobToken); err != nil {
		t.Fatalf("hmac ticket: %v", err)
	}
	frozen.Store(base.Add(4*time.Minute + 3*time.Second).UnixNano())
	if err := api.TickRecover(context.Background()); err != nil {
		t.Fatal(err)
	}
	job, err := workflows.GetJob(context.Background(), scope, claimed.Job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != wfstore.JobIndeterminate {
		t.Fatalf("recovered status = %s", job.Status)
	}
	done, _ := json.Marshal(map[string]any{
		"jobToken": claimed.JobToken, "workerId": "worker-a", "fencingToken": claimed.Job.FencingToken,
		"output": map[string]any{"ok": true},
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/"+claimed.Job.ID+"/complete", done, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")

	frozen.Store(base.Add(100 * 24 * time.Hour).UnixNano())
	if err := api.TickPurge(context.Background()); err != nil {
		t.Fatal(err)
	}
	execs, err = workflows.ListExecutions(context.Background(), scope, wfstore.ExecutionListFilter{WorkflowID: created.Workflow.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(execs) != 0 {
		t.Fatalf("retention purge left %d executions", len(execs))
	}
}

func TestConcurrentDispatchDoesNotDoubleStart(t *testing.T) {
	var frozen atomic.Int64
	base := time.Now().UTC().Add(time.Second)
	frozen.Store(base.UnixNano())
	now := func() time.Time { return time.Unix(0, frozen.Load()).UTC() }

	workflows := wfstore.NewMemory()
	ops := opsconfig.NewMemory()
	hooks := webhook.NewMemory()
	keys := vault.TestKeys()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:         identity.NewMemory(),
		Scoped:        isolation.NewMemory(),
		Sessions:      session.NewMemory(),
		Workflows:     workflows,
		Schedules:     schedule.NewMemory(),
		Ops:           ops,
		Hooks:         hooks,
		Vault:         vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:          keys,
		JobBindingKey: wfstore.NewJobBindingKey(),
		Approvals:     approval.NewMemory(),
		Now:           now,
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
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}
	ws, tenant := currentWorkspace(t, h, admin)
	scope, err := isolation.AuthorizeTenancy(ws.ID, admin.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}
	created := createWorkflow(t, h, admin, tenant, ws, scheduleYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "sched-once")
	body, _ := json.Marshal(map[string]any{
		"workflowId":        created.Workflow.ID,
		"workflowVersionId": pub.Version.ID,
		"timezone":          "UTC",
		"interval":          "PT1M",
		"overlapPolicy":     "skip",
		"catchUp":           0,
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create schedule: %d %s", rec.Code, rec.Body.String())
	}
	frozen.Store(base.Add(4 * time.Minute).UnixNano())

	const racers = 8
	var wg sync.WaitGroup
	errCh := make(chan error, racers)
	wg.Add(racers)
	for range racers {
		go func() {
			defer wg.Done()
			errCh <- api.TickDispatch(context.Background())
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	execs, err := workflows.ListExecutions(context.Background(), scope, wfstore.ExecutionListFilter{WorkflowID: created.Workflow.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(execs) != 1 {
		t.Fatalf("concurrent dispatch started %d executions, want 1", len(execs))
	}
}
