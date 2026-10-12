package fixturesuite

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/quota"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5/pgxpool"
)

const testIssuer = "https://idp.example"

// Env is the shared API + Postgres for one suite run.
type Env struct {
	ctx   context.Context
	h     http.Handler
	app   *pgxpool.Pool
	admin *pgxpool.Pool
	root  identity.User
	n     int64
	seq   atomic.Int64
}

// Workspace is one throwaway tenant + workspace with its role users.
type Workspace struct {
	env    *Env
	Tenant identity.Tenant
	WS     identity.Workspace
	Users  map[string]identity.User // owner, editor, viewer
}

// newEnv opens Postgres (migrating it) and builds the API handler the way
// the httpapi integration tests do. It skips without TEST_DATABASE_URL.
func newEnv(t *testing.T) *Env {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	t.Cleanup(cancel)
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	n := time.Now().UnixNano()
	root := identity.User{Issuer: testIssuer, ExternalSubject: fmt.Sprintf("fx-root-%d", n), DisplayName: "Fixture owner"}
	d := httpapi.Deps{
		Store:            identity.NewPostgres(app),
		Scoped:           isolation.NewPostgres(app),
		Workflows:        wfstore.NewPostgres(app),
		Ops:              opsconfig.NewPostgres(app),
		Approvals:        approval.NewPostgres(app),
		PlatformAdmins:   []authz.PrincipalRef{{Issuer: root.Issuer, Subject: root.ExternalSubject}},
		JobBindingKey:    wfstore.NewJobBindingKey(),
		Quota:            quota.Unlimited(),
		ScriptSigningKey: scripts.NewSigningKey(),
	}
	// Test-only: trust identity headers, as the httpapi tests do.
	d.Security.TrustIdentityHeaders = true
	return &Env{ctx: ctx, h: httpapi.NewWithDeps(d), app: app, admin: admin, root: root, n: n}
}

// Response is one recorded HTTP answer.
type Response struct {
	Status int
	Body   []byte
}

// Problem is the subset of a problem document the suite checks.
type Problem struct {
	Status int    `json:"status"`
	Code   string `json:"code"`
	Errors []struct {
		Path string `json:"path"`
		Code string `json:"code"`
	} `json:"errors"`
}

func (r Response) problem() Problem {
	var p Problem
	_ = json.Unmarshal(r.Body, &p)
	return p
}

func (e *Env) serve(req *http.Request) Response {
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return Response{Status: rec.Code, Body: rec.Body.Bytes()}
}

func newReq(method, path string, body any, user identity.User) *http.Request {
	var rd *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(core.HeaderIssuer, user.Issuer)
	req.Header.Set(core.HeaderSubject, user.ExternalSubject)
	if user.DisplayName != "" {
		req.Header.Set(core.HeaderDisplayName, user.DisplayName)
	}
	req.Header.Set(core.RequestIDHeader, "fixturesuite")
	return req
}

// NewWorkspace seeds a throwaway tenant and workspace with an owner (the
// platform admin who created it, admin role) and editor/viewer members.
func (e *Env) NewWorkspace(t *testing.T, label string) *Workspace {
	t.Helper()
	k := e.seq.Add(1)
	slug := fmt.Sprintf("fx%d-%d", e.n%1_000_000_000, k)
	res := e.serve(newReq(http.MethodPost, "/api/v1/tenants", map[string]string{"slug": slug, "name": "Fixture " + label}, e.root))
	if res.Status != http.StatusCreated {
		t.Fatalf("seed tenant: %d %s", res.Status, res.Body)
	}
	w := &Workspace{env: e, Users: map[string]identity.User{}}
	_ = json.Unmarshal(res.Body, &w.Tenant)
	res = e.serve(newReq(http.MethodPost, "/api/v1/workspaces", map[string]string{"tenant_slug": slug, "workbench_key": "fx", "name": "Fixture"}, e.root))
	if res.Status != http.StatusCreated {
		t.Fatalf("seed workspace: %d %s", res.Status, res.Body)
	}
	_ = json.Unmarshal(res.Body, &w.WS)
	w.Users["owner"] = e.root
	for _, role := range []string{authz.RoleEditor, authz.RoleViewer} {
		u := identity.User{Issuer: testIssuer, ExternalSubject: fmt.Sprintf("fx-%s-%d-%d", role, e.n, k), DisplayName: "Fixture " + role}
		res := w.Do(e.root, http.MethodPut, "/api/v1/workspace/members", map[string]any{
			"issuer": u.Issuer, "external_subject": u.ExternalSubject, "display_name": u.DisplayName, "role_keys": []string{role},
		})
		if res.Status != http.StatusOK {
			t.Fatalf("seed %s: %d %s", role, res.Status, res.Body)
		}
		var m identity.Member
		_ = json.Unmarshal(res.Body, &m)
		w.Users[role] = m.User
	}
	return w
}

// Do sends a workspace-scoped request as user.
func (w *Workspace) Do(user identity.User, method, path string, body any) Response {
	req := newReq(method, path, body, user)
	req.Header.Set(core.HeaderTenantID, w.Tenant.ID)
	req.Header.Set(core.HeaderTenantSlug, w.Tenant.Slug)
	req.Header.Set(core.HeaderWorkbenchKey, w.WS.WorkbenchKey)
	return w.env.serve(req)
}

// Draft is a created workflow and its draft revision.
type Draft struct {
	WorkflowID string
	Revision   int64
}

// Create creates the workflow draft from YAML.
func (w *Workspace) Create(user identity.User, src string) (Draft, Response) {
	res := w.Do(user, http.MethodPost, "/api/v1/workflows", map[string]string{"definitionYaml": src})
	var out struct {
		Workflow struct {
			ID string `json:"id"`
		} `json:"workflow"`
		Draft struct {
			Revision int64 `json:"revision"`
		} `json:"draft"`
	}
	_ = json.Unmarshal(res.Body, &out)
	return Draft{WorkflowID: out.Workflow.ID, Revision: out.Draft.Revision}, res
}

// Publish publishes the draft and returns the version id.
func (w *Workspace) Publish(user identity.User, d Draft) (string, Response) {
	res := w.Do(user, http.MethodPost, "/api/v1/workflows/"+d.WorkflowID+"/publish", map[string]any{"revision": d.Revision, "note": "fixturesuite"})
	var out struct {
		Version struct {
			ID string `json:"id"`
		} `json:"version"`
	}
	_ = json.Unmarshal(res.Body, &out)
	return out.Version.ID, res
}

// Start starts the published version and returns the execution id.
func (w *Workspace) Start(user identity.User, workflowID, versionID string, input map[string]any) (string, Response) {
	body := map[string]any{"workflowVersionId": versionID}
	if len(input) > 0 {
		body["input"] = input
	}
	res := w.Do(user, http.MethodPost, "/api/v1/workflows/"+workflowID+"/executions", body)
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &out)
	return out.ID, res
}

// Run is the observed state of one execution.
type Run struct {
	Status string
	Reason string
	Steps  map[string]wfstore.ExecutionStep // latest attempt per node
	Audit  map[string]int                   // action -> rows for this execution
}

// Observe reads the execution, its steps, and its audit rows.
func (w *Workspace) Observe(t *testing.T, execID string) Run {
	t.Helper()
	owner := w.Users["owner"]
	res := w.Do(owner, http.MethodGet, "/api/v1/executions/"+execID, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("get execution: %d %s", res.Status, res.Body)
	}
	var exec struct {
		Status       string `json:"status"`
		StatusReason string `json:"statusReason"`
	}
	_ = json.Unmarshal(res.Body, &exec)
	res = w.Do(owner, http.MethodGet, "/api/v1/executions/"+execID+"/steps", nil)
	if res.Status != http.StatusOK {
		t.Fatalf("list steps: %d %s", res.Status, res.Body)
	}
	var steps struct {
		Items []wfstore.ExecutionStep `json:"items"`
	}
	_ = json.Unmarshal(res.Body, &steps)
	run := Run{Status: exec.Status, Reason: exec.StatusReason, Steps: map[string]wfstore.ExecutionStep{}, Audit: map[string]int{}}
	for _, s := range steps.Items {
		if cur, ok := run.Steps[s.NodeID]; !ok || s.Attempt >= cur.Attempt {
			run.Steps[s.NodeID] = s
		}
	}
	// Audit rows tied to this run: the execution itself, its steps and
	// jobs (resource_id), or its correlation id.
	rows, err := w.env.admin.Query(w.env.ctx, `
SELECT action, count(*) FROM audit_events
 WHERE workspace_id = $1::uuid
   AND (resource_id = $2::uuid
        OR resource_id IN (SELECT id FROM execution_steps WHERE execution_id = $2::uuid)
        OR resource_id IN (SELECT id FROM execution_jobs WHERE execution_id = $2::uuid)
        OR details_redacted->>'executionId' = $2::text)
 GROUP BY action`, w.WS.ID, execID)
	if err != nil {
		t.Fatalf("audit query: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var action string
		var n int
		if err := rows.Scan(&action, &n); err != nil {
			t.Fatal(err)
		}
		run.Audit[action] = n
	}
	return run
}
