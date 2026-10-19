package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Whole numbers above 2^53 sent through run-start or a webhook must reach
// the stored execution input and every API echo with their exact digits.

const exactIntakeYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: exact-intake
spec:
  triggers:
    - id: manual
      type: manual
    - id: hook
      type: webhook
      contentType: application/json
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`

var exactIntakeCases = []struct {
	name, literal string
}{
	{"above 2^53", `9007199254740993`},
	{"17 digits", `12345678901234567`},
	{"string id", `"9007199254740993"`},
	{"small", `42`},
}

type exactIntakeEnv struct {
	h        http.Handler
	user     identity.User
	tenant   identity.Tenant
	ws       identity.Workspace
	store    wfstore.Store
	storedFn func(t *testing.T, executionID string) string // raw stored input JSON, "" if not applicable
}

func runExactIntake(t *testing.T, env exactIntakeEnv) {
	created := createWorkflow(t, env.h, env.user, env.tenant, env.ws, exactIntakeYAML)
	pub := publishWorkflow(t, env.h, env.user, env.tenant, env.ws, created.Workflow.ID, created.Draft.Revision, "exact")
	cred := createVaultCredential(t, env.h, env.user, env.tenant, env.ws, "webhook_secret", "Hook", map[string]string{"secret": webhookSecretPlain})
	rootHook := createWebhookTrigger(t, env.h, env.user, env.tenant, env.ws, created.Workflow.ID, pub.Version.ID, cred.ID, map[string]any{"triggerId": "hook"})
	mappedHook := createWebhookTrigger(t, env.h, env.user, env.tenant, env.ws, created.Workflow.ID, pub.Version.ID, cred.ID, map[string]any{"triggerId": "hook", "fieldMapping": map[string]string{"id": "order.id"}})
	scope, err := isolation.AuthorizeSystemTenancy(env.ws.ID, env.tenant.ID, env.ws.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}

	check := func(t *testing.T, label, literal string, body []byte, execID string) {
		t.Helper()
		want := `"id":` + literal
		if !strings.Contains(string(body), want) {
			t.Fatalf("%s response lost digits, want %s in %s", label, want, body)
		}
		// Stored execution, as the store returns it.
		exec, err := env.store.GetExecution(context.Background(), scope, created.Workflow.ID, execID)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(exec.Input)
		if !strings.Contains(string(raw), want) {
			t.Fatalf("%s stored input = %s, want %s", label, raw, want)
		}
		if env.storedFn != nil {
			if row := env.storedFn(t, execID); !strings.Contains(strings.ReplaceAll(row, " ", ""), want) {
				t.Fatalf("%s input_redacted = %s, want %s", label, row, want)
			}
		}
		rec := httptest.NewRecorder()
		env.h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/executions/"+execID, nil, env.user, env.tenant, env.ws))
		if rec.Code != http.StatusOK {
			t.Fatalf("get execution: %d %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("%s GET lost digits, want %s in %s", label, want, rec.Body.String())
		}
	}
	execID := func(t *testing.T, body []byte) string {
		t.Helper()
		var out executionResponse
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		return out.ID
	}

	for i, tc := range exactIntakeCases {
		t.Run("run-start "+tc.name, func(t *testing.T) {
			body := []byte(`{"workflowVersionId":"` + pub.Version.ID + `","input":{"id":` + tc.literal + `}}`)
			rec := httptest.NewRecorder()
			env.h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, env.user, env.tenant, env.ws))
			if rec.Code != http.StatusCreated {
				t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
			}
			check(t, "run-start", tc.literal, rec.Body.Bytes(), execID(t, rec.Body.Bytes()))
		})
		for j, hook := range []struct {
			name string
			trig webhook.Trigger
			body string
		}{
			{"root", rootHook, `{"id":` + tc.literal + `}`},
			{"mapped", mappedHook, `{"order":{"id":` + tc.literal + `}}`},
		} {
			t.Run("webhook "+hook.name+" "+tc.name, func(t *testing.T) {
				payload := []byte(hook.body)
				ts := strconv.FormatInt(time.Now().Unix()+int64(i*2+j), 10)
				rec := httptest.NewRecorder()
				env.h.ServeHTTP(rec, signedHook(hook.trig.PublicID, ts, webhook.SignV1([]byte(webhookSecretPlain), ts, payload), payload))
				if rec.Code != http.StatusCreated {
					t.Fatalf("webhook: %d %s", rec.Code, rec.Body.String())
				}
				check(t, "webhook", tc.literal, rec.Body.Bytes(), execID(t, rec.Body.Bytes()))
			})
		}
	}

	t.Run("signature still covers the exact raw bytes", func(t *testing.T) {
		sent := []byte(`{"id":9007199254740993}`)
		rounded := []byte(`{"id":9007199254740992}`)
		ts := strconv.FormatInt(time.Now().Unix()+50, 10)
		rec := httptest.NewRecorder()
		env.h.ServeHTTP(rec, signedHook(rootHook.PublicID, ts, webhook.SignV1([]byte(webhookSecretPlain), ts, rounded), sent))
		assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
	})
}

func TestExactBigIntIntakeMemory(t *testing.T) {
	store := identity.NewMemory()
	keys := vault.TestKeys()
	workflows := wfstore.NewMemory()
	ops := opsconfig.NewMemory()
	hooks := webhook.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:     store,
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: workflows,
		Ops:       ops,
		Hooks:     hooks,
		Vault:     vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:      keys,
		Approvals: approval.NewMemory(),
	}))
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	tenant, ws := exactIntakeTenant(t, h, admin, "acme")
	runExactIntake(t, exactIntakeEnv{h: h, user: admin, tenant: tenant, ws: ws, store: workflows})
}

func TestExactBigIntIntakeAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	n := time.Now().UnixNano()
	user := identity.User{Issuer: "https://idp.example", ExternalSubject: fmt.Sprintf("exact-intake-%d", n), DisplayName: "Admin"}
	keys := vault.TestKeys()
	workflows := wfstore.NewPostgres(pool)
	ops := opsconfig.NewMemory()
	hooks := webhook.NewPostgres(pool)
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:          identity.NewPostgres(pool),
		Scoped:         isolation.NewPostgres(pool),
		Sessions:       session.NewMemory(),
		Workflows:      workflows,
		Ops:            ops,
		Hooks:          hooks,
		Vault:          vault.NewPostgres(pool, keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:           keys,
		Approvals:      approval.NewMemory(),
		PlatformAdmins: []authz.PrincipalRef{{Issuer: user.Issuer, Subject: user.ExternalSubject}},
	}))
	tenant, ws := exactIntakeTenant(t, h, user, fmt.Sprintf("ei%d", n%1_000_000_000_000))
	runExactIntake(t, exactIntakeEnv{h: h, user: user, tenant: tenant, ws: ws, store: workflows,
		storedFn: func(t *testing.T, executionID string) string {
			var row string
			if err := admin.QueryRow(ctx, `SELECT input_redacted::text FROM executions WHERE id = $1::uuid`, executionID).Scan(&row); err != nil {
				t.Fatal(err)
			}
			return row
		}})
}

func exactIntakeTenant(t *testing.T, h http.Handler, user identity.User, slug string) (identity.Tenant, identity.Workspace) {
	t.Helper()
	var tenant identity.Tenant
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"`+slug+`","name":"Exact"}`, user))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &tenant); err != nil {
		t.Fatal(err)
	}
	var ws identity.Workspace
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"`+slug+`","workbench_key":"ops","name":"Ops"}`, user))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ws); err != nil {
		t.Fatal(err)
	}
	return tenant, ws
}
