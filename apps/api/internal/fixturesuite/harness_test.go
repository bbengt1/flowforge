package fixturesuite

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
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
	// skew is the fake clock's offset (ns) from real time, shared by the
	// API (Deps.Now) and the runner driver (runner.Config.Now). The clock
	// keeps ticking with real time so rows stamped by Postgres now() are
	// never ahead of it; Advance only ever moves it forward.
	skew   atomic.Int64
	jobKey []byte
	api    *httpapi.API
}

// Now is the suite's fake clock.
func (e *Env) Now() time.Time { return time.Now().Add(time.Duration(e.skew.Load())).UTC() }

// Advance moves the fake clock forward.
func (e *Env) Advance(d time.Duration) { e.skew.Add(int64(d)) }

// Workspace is one throwaway tenant + workspace with its role users.
type Workspace struct {
	env    *Env
	Tenant identity.Tenant
	WS     identity.Workspace
	Users  map[string]identity.User // owner, editor, viewer
	gen    int                      // worker generation (kill-runner bumps it)
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
	env := &Env{ctx: ctx, app: app, admin: admin, root: root, n: n, jobKey: wfstore.NewJobBindingKey()}
	d := httpapi.Deps{
		Store:            identity.NewPostgres(app),
		Scoped:           isolation.NewPostgres(app),
		Workflows:        wfstore.NewPostgres(app),
		Ops:              opsconfig.NewPostgres(app),
		Approvals:        approval.NewPostgres(app),
		PlatformAdmins:   []authz.PrincipalRef{{Issuer: root.Issuer, Subject: root.ExternalSubject}},
		JobBindingKey:    env.jobKey,
		Now:              env.Now,
		Quota:            quota.Unlimited(),
		ScriptSigningKey: scripts.NewSigningKey(),
	}
	// Test-only: trust identity headers, as the httpapi tests do.
	d.Security.TrustIdentityHeaders = true
	env.h = httpapi.NewWithDeps(d)
	api, ok := env.h.(*httpapi.API)
	if !ok {
		t.Fatalf("handler is %T, want *httpapi.API", env.h)
	}
	env.api = api
	return env
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
	Status   string
	Reason   string
	Steps    map[string]Step   // latest attempt per node
	Attempts map[string][]Step // every attempt per node, oldest first
	Audit    map[string]int    // action -> rows for this execution
	// AuditRows holds each row's details_redacted plus "outcome".
	AuditRows map[string][]map[string]any
}

// Step is a step row as the run API returns it (skipReason is #660).
// ErrorHandling is the step's onError mode as the run API reports it
// (#649 S2); it is empty until the API sends it.
type Step struct {
	wfstore.ExecutionStep
	ErrorHandling string `json:"errorHandling"`
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
		Items []Step `json:"items"`
	}
	_ = json.Unmarshal(res.Body, &steps)
	run := Run{Status: exec.Status, Reason: exec.StatusReason, Steps: map[string]Step{}, Attempts: map[string][]Step{},
		Audit: map[string]int{}, AuditRows: map[string][]map[string]any{}}
	for _, s := range steps.Items {
		if cur, ok := run.Steps[s.NodeID]; !ok || s.Attempt >= cur.Attempt {
			run.Steps[s.NodeID] = s
		}
		run.Attempts[s.NodeID] = append(run.Attempts[s.NodeID], s)
	}
	for _, list := range run.Attempts {
		sort.SliceStable(list, func(i, j int) bool { return list[i].Attempt < list[j].Attempt })
	}
	// Audit rows tied to this run: the execution itself, its steps and
	// jobs (resource_id), or its correlation id.
	rows, err := w.env.admin.Query(w.env.ctx, `
SELECT action, outcome, details_redacted FROM audit_events
 WHERE workspace_id = $1::uuid
   AND (resource_id = $2::uuid
        OR resource_id IN (SELECT id FROM execution_steps WHERE execution_id = $2::uuid)
        OR resource_id IN (SELECT id FROM execution_jobs WHERE execution_id = $2::uuid)
        OR details_redacted->>'executionId' = $2::text)
`, w.WS.ID, execID)
	if err != nil {
		t.Fatalf("audit query: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var action, outcome string
		var details map[string]any
		if err := rows.Scan(&action, &outcome, &details); err != nil {
			t.Fatal(err)
		}
		if details == nil {
			details = map[string]any{}
		}
		details["outcome"] = outcome
		run.Audit[action]++
		run.AuditRows[action] = append(run.AuditRows[action], details)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("audit rows: %v", err)
	}
	return run
}

// Executions counts the workspace's executions (each part gets a fresh
// workspace, so this is the part's executionsDelta).
func (w *Workspace) Executions(t *testing.T) int {
	t.Helper()
	var n int
	if err := w.env.admin.QueryRow(w.env.ctx, `SELECT count(*) FROM executions WHERE workspace_id = $1::uuid`, w.WS.ID).Scan(&n); err != nil {
		t.Fatalf("count executions: %v", err)
	}
	return n
}

// JobCount counts execution_jobs rows for one node of an execution.
func (w *Workspace) JobCount(t *testing.T, execID, node string) int {
	t.Helper()
	var n int
	err := w.env.admin.QueryRow(w.env.ctx, `
SELECT count(*) FROM execution_jobs j
  JOIN execution_steps s ON s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
 WHERE j.workspace_id = $1::uuid AND j.execution_id = $2::uuid AND s.node_id = $3`, w.WS.ID, execID, node).Scan(&n)
	if err != nil {
		t.Fatalf("count jobs: %v", err)
	}
	return n
}

// SaveDraft replaces the workflow's draft with src and returns the new
// draft revision.
func (w *Workspace) SaveDraft(user identity.User, d Draft, src string) (Draft, Response) {
	res := w.Do(user, http.MethodPut, "/api/v1/workflows/"+d.WorkflowID+"/draft", map[string]any{"revision": d.Revision, "definitionYaml": src})
	var out struct {
		Revision int64 `json:"revision"`
		Draft    struct {
			Revision int64 `json:"revision"`
		} `json:"draft"`
	}
	_ = json.Unmarshal(res.Body, &out)
	rev := out.Draft.Revision
	if rev == 0 {
		rev = out.Revision
	}
	return Draft{WorkflowID: d.WorkflowID, Revision: rev}, res
}

// Retry retries the execution's latest retryable step as user.
func (w *Workspace) Retry(user identity.User, execID string) Response {
	return w.Do(user, http.MethodPost, "/api/v1/executions/"+execID+"/retry", nil)
}
