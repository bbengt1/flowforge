package fixturesuite

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/google/uuid"
)

// TestSecuritySpecsAreValid lints security/*.yaml (no database).
func TestSecuritySpecsAreValid(t *testing.T) {
	specs, err := LoadSecuritySpecs(securityDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(specs) == 0 {
		t.Fatal("no security specs found")
	}
}

// TestSecurity runs every security check on every driver, strictly.
// Each (spec, driver) gets a fresh world: tenant A with seeded runs,
// approval, credentials and a draft-only workflow, plus tenant B.
func TestSecurity(t *testing.T) {
	specs, err := LoadSecuritySpecs(securityDir)
	if err != nil {
		t.Fatal(err)
	}
	env := newEnv(t)
	all := drivers()
	for _, spec := range specs {
		for _, dname := range spec.Drivers {
			spec, d := spec, all[dname]
			t.Run(spec.ID+"/"+dname, func(t *testing.T) {
				if !driverSelected(dname) {
					t.Skipf("driver %s not in FIXTURESUITE_DRIVERS", dname)
				}
				if blackboxURL() != "" {
					t.Skip("black-box (#673): S3 security specs run on the in-process nightly job only")
				}
				stop := env.Capture()
				w := newSecWorld(t, env, d)
				for _, c := range spec.Checks {
					c := c
					t.Run(c.Name, func(t *testing.T) {
						var fails []string
						failf := func(f string, a ...any) { fails = append(fails, fmt.Sprintf(f, a...)) }
						w.run(t, c, failf, stop)
						x := spec.xfailFor(c.Name, dname)
						outcome, msg := Verdict(spec.ID+"/"+c.Name, dname, x, fails)
						t.Logf("%s %s/%s/%s %v", outcome, spec.ID, c.Name, dname, fails)
						r := Result{Suite: "security", ID: spec.ID, Part: c.Name, Driver: dname, Outcome: outcome, Failures: fails}
						if x != nil {
							r.XFail = x.Issue
						}
						recordResult(t, r)
						if outcome.Failing() {
							t.Error(msg)
						}
					})
				}
				stop()
			})
		}
	}
}

// secWorld is the seeded state the checks run against.
type secWorld struct {
	env   *Env
	d     Driver
	A, B  *Workspace
	users map[string]identity.User
	vars  map[string]string
	// captured responses so far (canary scan reads them)
	captured []Response
}

func readFixture(t *testing.T, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixturesDir, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

const secGateYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: s3-gate
spec:
  triggers:
    - {id: manual, type: manual}
  nodes:
    - {id: gate, type: flow.approval, name: Gate, with: {approverRole: approver, expiresIn: PT15M}}
    - {id: ok, type: flow.stop, name: Approved, with: {status: success}}
  edges:
    - {from: gate.approved, to: ok.input}
`

func targetedGate(userID string) string {
	return strings.Replace(secGateYAML, "expiresIn: PT15M}", "expiresIn: PT15M, approvers: {users: ["+userID+"], groups: []}}", 1)
}

// addMember puts a member with roles into w and returns the user.
func addMember(t *testing.T, w *Workspace, issuer, subject string, roles ...string) identity.User {
	t.Helper()
	u := identity.User{Issuer: issuer, ExternalSubject: subject, DisplayName: "Fixture " + subject}
	res := w.Do(w.env.root, http.MethodPut, "/api/v1/workspace/members", map[string]any{
		"issuer": u.Issuer, "external_subject": u.ExternalSubject, "display_name": u.DisplayName, "role_keys": roles,
	})
	if res.Status != http.StatusOK {
		t.Fatalf("add member %s: %d %s", subject, res.Status, res.Body)
	}
	var m identity.Member
	_ = json.Unmarshal(res.Body, &m)
	m.User.Issuer, m.User.ExternalSubject, m.User.DisplayName = u.Issuer, u.ExternalSubject, u.DisplayName
	return m.User
}

func mustStatus(t *testing.T, what string, res Response, want int) {
	t.Helper()
	if res.Status != want {
		t.Fatalf("setup %s: %d %s", what, res.Status, res.Body)
	}
}

// publishRun creates, publishes and (when start) starts src as user.
func (w *secWorld) publishRun(t *testing.T, ws *Workspace, as identity.User, src string, start bool) (Draft, string, string) {
	t.Helper()
	owner := ws.Users["owner"]
	draft, res := ws.Create(owner, src)
	mustStatus(t, "create", res, http.StatusCreated)
	ver, res := ws.Publish(owner, draft)
	mustStatus(t, "publish", res, http.StatusCreated)
	if !start {
		return draft, ver, ""
	}
	id, res := ws.Start(as, draft.WorkflowID, ver, nil)
	mustStatus(t, "start", res, http.StatusCreated)
	return draft, ver, id
}

func (w *secWorld) approvalFor(t *testing.T, ws *Workspace, execID string) string {
	t.Helper()
	res := ws.Do(ws.Users["owner"], http.MethodGet, "/api/v1/approvals?executionId="+execID, nil)
	mustStatus(t, "list approvals", res, http.StatusOK)
	var out struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(res.Body, &out)
	if len(out.Items) == 0 {
		t.Fatalf("setup: no approval parked for %s", execID)
	}
	return out.Items[0].ID
}

func newSecWorld(t *testing.T, env *Env, d Driver) *secWorld {
	t.Helper()
	w := &secWorld{env: env, d: d, users: map[string]identity.User{}, vars: map[string]string{}}
	A := env.NewWorkspace(t, "s3-A")
	w.A = A
	k := env.seq.Add(1)
	sub := func(role string) string { return fmt.Sprintf("fx-s3-%s-%d-%d", role, env.n, k) }
	for r, u := range A.Users {
		w.users[r] = u
	}
	w.users["operator"] = addMember(t, A, testIssuer, sub("operator"), authz.RoleOperator)
	w.users["approver"] = addMember(t, A, testIssuer, sub("approver"), authz.RoleApprover)
	w.users["requester"] = addMember(t, A, testIssuer, sub("requester"), authz.RoleOperator, authz.RoleApprover)
	w.users["machine"] = addMember(t, A, machine.Issuer, sub("machine"), authz.RoleApprover)
	B := env.NewWorkspace(t, "s3-B")
	w.B = B
	// B.owner is admin of B only (the suite root administers every
	// workspace, so it cannot stand in for a foreign tenant).
	w.users["B.owner"] = addMember(t, B, testIssuer, sub("bowner"), authz.RoleAdmin)

	for _, c := range []string{"CRED", "WHSEC"} {
		w.vars["canary."+c] = "FFCANARY-" + c + "-" + uuid.NewString()
	}
	owner := w.users["owner"]
	// 01 published and run.
	draft, ver, exec := w.publishRun(t, A, owner, readFixture(t, "01-linear/workflow.yaml"), true)
	if err := d.Drive(t, A); err != nil {
		t.Fatalf("setup drive: %v", err)
	}
	w.vars["A.workflow"], w.vars["A.version"], w.vars["A.execution"] = draft.WorkflowID, ver, exec
	w.vars["A.revision"] = fmt.Sprint(draft.Revision)
	// 06 plain failure (retryable).
	_, _, failed := w.publishRun(t, A, owner, readFixture(t, "06-error-output/workflow.yaml"), true)
	if err := d.Drive(t, A); err != nil {
		t.Fatalf("setup drive: %v", err)
	}
	w.vars["A.failedExecution"] = failed
	// Approval parked, requested by requester.
	_, _, gated := w.publishRun(t, A, w.users["requester"], secGateYAML, true)
	if err := d.DriveOnce(t, A); err != nil {
		t.Fatalf("setup drive-once: %v", err)
	}
	w.vars["A.approvalExecution"] = gated
	w.vars["A.approval"] = w.approvalFor(t, A, gated)
	// Credentials carrying canaries.
	res := A.Do(owner, http.MethodPost, "/api/v1/credentials", map[string]any{
		"type": "token", "displayName": "s3 canary", "secret": map[string]string{"token": w.vars["canary.CRED"]},
	})
	mustStatus(t, "credential", res, http.StatusCreated)
	var cred struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &cred)
	w.vars["A.credential"] = cred.ID
	res = A.Do(owner, http.MethodPost, "/api/v1/credentials", map[string]any{
		"type": "webhook_secret", "displayName": "s3 webhook canary", "secret": map[string]string{"secret": w.vars["canary.WHSEC"]},
	})
	mustStatus(t, "webhook secret", res, http.StatusCreated)
	// Read paths the scan covers.
	for _, p := range []string{"/api/v1/credentials", "/api/v1/credentials/" + cred.ID, "/api/v1/credentials/" + cred.ID + "/events",
		"/api/v1/executions/" + exec, "/api/v1/executions/" + exec + "/steps", "/api/v1/executions/" + exec + "/audit-events",
		"/api/v1/executions/" + failed + "/steps", "/api/v1/approvals", "/api/v1/approvals/" + w.vars["A.approval"]} {
		A.Do(owner, http.MethodGet, p, nil)
	}
	// Draft-only workflow.
	d2, res := A.Create(owner, strings.Replace(readFixture(t, "01-linear/workflow.yaml"), "e0-01-linear", "s3-draft-only", 1))
	mustStatus(t, "draft-only", res, http.StatusCreated)
	w.vars["A.draftOnly"], w.vars["A.draftRevision"] = d2.WorkflowID, fmt.Sprint(d2.Revision)
	w.vars["A.workspace"] = A.WS.ID
	return w
}

// expand replaces {A.x} / {canary.X} / {fixture:path} in s.
func (w *secWorld) expand(t *testing.T, s string) string {
	t.Helper()
	for k, v := range w.vars {
		s = strings.ReplaceAll(s, "{"+k+"}", v)
	}
	for {
		i := strings.Index(s, "{fixture:")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], "}")
		s = s[:i] + readFixture(t, s[i+len("{fixture:"):i+j]) + s[i+j+1:]
	}
	return s
}

func (w *secWorld) expandAny(t *testing.T, v any) any {
	switch x := v.(type) {
	case string:
		s := w.expand(t, x)
		// numeric placeholders ({A.revision}) become numbers
		var n json.Number
		if strings.HasPrefix(x, "{") && json.Unmarshal([]byte(s), &n) == nil {
			return n
		}
		return s
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = w.expandAny(t, e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = w.expandAny(t, e)
		}
		return out
	}
	return v
}

// do sends a request into A (B.owner sends with A's workspace headers
// replaced by B's: a foreign principal in its own workspace asking for
// A's ids).
func (w *secWorld) do(t *testing.T, as, method, path string, body any) Response {
	t.Helper()
	var b any
	if body != nil {
		b = w.expandAny(t, body)
	}
	path = w.expand(t, path)
	switch as {
	case "none":
		req := newReq(method, path, b, identity.User{})
		req.Header.Del(core.HeaderIssuer)
		req.Header.Del(core.HeaderSubject)
		req.Header.Set(core.HeaderTenantID, w.A.Tenant.ID)
		req.Header.Set(core.HeaderTenantSlug, w.A.Tenant.Slug)
		req.Header.Set(core.HeaderWorkbenchKey, w.A.WS.WorkbenchKey)
		return w.env.serve(req)
	case "B.owner":
		return w.B.Do(w.users[as], method, path, b)
	}
	if as == "" {
		as = "owner"
	}
	return w.A.Do(w.users[as], method, path, b)
}

// count reads one side-effect counter in workspace A.
func (w *secWorld) count(t *testing.T, key string) int {
	t.Helper()
	var q string
	var args []any
	switch {
	case key == "executions":
		q, args = `SELECT count(*) FROM executions WHERE workspace_id = $1::uuid`, []any{w.A.WS.ID}
	case key == "approval_decisions":
		// decision rows: approved/rejected events plus approvals marked decided
		q, args = `SELECT (SELECT count(*) FROM approval_events WHERE workspace_id = $1::uuid AND event_type IN ('approved', 'rejected'))
		            + (SELECT count(*) FROM approvals WHERE workspace_id = $1::uuid AND decided_by IS NOT NULL)`, []any{w.A.WS.ID}
	case key == "approval_events":
		q, args = `SELECT count(*) FROM approval_events WHERE workspace_id = $1::uuid`, []any{w.A.WS.ID}
	case strings.HasPrefix(key, "audit:"):
		q, args = `SELECT count(*) FROM audit_events WHERE workspace_id = $1::uuid AND action = $2`, []any{w.A.WS.ID, strings.TrimPrefix(key, "audit:")}
	default:
		t.Fatalf("unknown sideEffects key %q (executions, approval_events, approval_decisions, audit:<action>)", key)
	}
	var n int
	if err := w.env.admin.QueryRow(w.env.ctx, q, args...).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", key, err)
	}
	return n
}

func (w *secWorld) withSideEffects(t *testing.T, want map[string]int, failf func(string, ...any), fn func()) {
	t.Helper()
	before := map[string]int{}
	for k := range want {
		before[k] = w.count(t, k)
	}
	fn()
	for _, k := range sortedKeysInt(want) {
		if got := w.count(t, k) - before[k]; got != want[k] {
			failf("sideEffect %s = %+d, want %+d", k, got, want[k])
		}
	}
}

func sortedKeysInt(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (w *secWorld) run(t *testing.T, c SecCheck, failf func(string, ...any), stop func() []Response) {
	t.Helper()
	switch c.Kind {
	case "http", "route-absent":
		w.withSideEffects(t, c.SideEffects, failf, func() {
			res := w.do(t, c.As, c.Method, c.Path, c.Body)
			checkHTTP(failf, c.Method+" "+c.Path+" as "+c.As, HTTPExpect{Status: c.Status, Code: c.Code}, res)
			for _, s := range c.NeverStatus {
				if res.Status == s {
					failf("status %d is never allowed here", s)
				}
			}
		})
	case "csrf":
		w.runCSRF(t, c, failf)
	case "sql-rows":
		w.runSQLRows(t, c, failf)
	case "audit":
		w.runAudit(t, c, failf)
	case "canary-scan":
		w.runCanary(t, c, failf, stop)
	case "guard":
		w.runGuard(t, c, failf)
	case "start":
		before := w.count(t, "executions")
		body := map[string]any{}
		if m, ok := w.expandAny(t, c.Body).(map[string]any); ok {
			body = m
		}
		res := w.do(t, c.As, http.MethodPost, "/api/v1/workflows/{A.draftOnly}/executions", body)
		checkHTTP(failf, "start draft-only", HTTPExpect{Status: c.Status, Code: c.Code}, res)
		if c.ExecutionsDelta != nil {
			if got := w.count(t, "executions") - before; got != *c.ExecutionsDelta {
				failf("executionsDelta = %d, want %d", got, *c.ExecutionsDelta)
			}
		}
	case "version-pin":
		w.runVersionPin(t, c, failf)
	default:
		failf("kind %q has no evaluator", c.Kind)
	}
}

func (w *secWorld) runCSRF(t *testing.T, c SecCheck, failf func(string, ...any)) {
	t.Helper()
	as := c.As
	if as == "" {
		as = "owner"
	}
	owner := w.users[as]
	req := newReq(http.MethodPost, "/api/v1/session", map[string]string{
		"issuer": owner.Issuer, "external_subject": owner.ExternalSubject, "display_name": owner.DisplayName,
	}, owner)
	rec := w.env.serve(req)
	if rec.Status != http.StatusCreated {
		failf("create session: %d %s", rec.Status, rec.Body)
		return
	}
	var token, csrf string
	for _, raw := range rec.Header.Values("Set-Cookie") {
		if ck, err := http.ParseSetCookie(raw); err == nil {
			switch ck.Name {
			case session.CookieName:
				token = ck.Value
			case session.CSRFCookieName:
				csrf = ck.Value
			}
		}
	}
	if token == "" || csrf == "" {
		failf("session cookies missing")
		return
	}
	w.withSideEffects(t, c.SideEffects, failf, func() {
		var b any
		if c.Body != nil {
			b = w.expandAny(t, c.Body)
		}
		r := newReq(c.Method, w.expand(t, c.Path), b, identity.User{})
		r.Header.Del(core.HeaderIssuer)
		r.Header.Del(core.HeaderSubject)
		r.Header.Set(core.HeaderTenantID, w.A.Tenant.ID)
		r.Header.Set(core.HeaderTenantSlug, w.A.Tenant.Slug)
		r.Header.Set(core.HeaderWorkbenchKey, w.A.WS.WorkbenchKey)
		r.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
		r.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
		switch c.Session {
		case "bad-token":
			r.Header.Set(session.CSRFHeader, "bad-"+csrf)
		case "valid":
			r.Header.Set(session.CSRFHeader, csrf)
		}
		checkHTTP(failf, "csrf "+c.Session, HTTPExpect{Status: c.Status, Code: c.Code}, w.env.serve(r))
	})
}

// runSQLRows: as the app role with B's workspace set, A's rows are
// invisible (RLS).
func (w *secWorld) runSQLRows(t *testing.T, c SecCheck, failf func(string, ...any)) {
	t.Helper()
	ctx := w.env.ctx
	tx, err := w.env.app.Begin(ctx)
	if err != nil {
		failf("begin: %v", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var role string
	if err := tx.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil || role == "" {
		failf("current_user: %v", err)
		return
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.workspace_id', $1, true)`, w.B.WS.ID); err != nil {
		failf("set workspace: %v", err)
		return
	}
	for _, table := range c.Tables {
		if !secTables[table] {
			failf("table %q is not in the isolation list", table)
			continue
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE workspace_id = $1::uuid`, w.A.WS.ID).Scan(&n); err != nil {
			failf("%s: %v", table, err)
			continue
		}
		if c.Rows != nil && n != *c.Rows {
			failf("as %s (role %s, workspace B) %s rows of A = %d, want %d", c.As, role, table, n, *c.Rows)
		}
		// Sanity: A really has rows there (else the check proves nothing).
		var total int
		_ = w.env.admin.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE workspace_id = $1::uuid`, w.A.WS.ID).Scan(&total)
		if total == 0 {
			failf("%s: tenant A has no rows, the isolation check is vacuous", table)
		}
	}
}

var secTables = map[string]bool{
	"workflows": true, "workflow_versions": true, "executions": true, "execution_steps": true, "execution_jobs": true,
	"credentials": true, "approvals": true, "approval_events": true, "audit_events": true,
}

func (w *secWorld) runGuard(t *testing.T, c SecCheck, failf func(string, ...any)) {
	t.Helper()
	src, err := ApplyPatch(readFixture(t, c.Fixture), c.Patch)
	if err != nil {
		failf("patch: %v", err)
		return
	}
	var before int
	countWF := func() int {
		var n int
		_ = w.env.admin.QueryRow(w.env.ctx, `SELECT count(*) FROM workflows WHERE workspace_id = $1::uuid`, w.A.WS.ID).Scan(&n)
		return n
	}
	before = countWF()
	owner := w.users["owner"]
	draft, res := w.A.Create(owner, src)
	if res.Status == http.StatusCreated {
		_, res = w.A.Publish(owner, draft)
	}
	checkHTTP(failf, "guard "+c.Fixture, HTTPExpect{Status: c.Status, Code: c.Code, Errors: c.Errors}, res)
	if c.WorkflowsDelta != nil {
		if got := countWF() - before; got != *c.WorkflowsDelta {
			failf("workflowsDelta = %d, want %d", got, *c.WorkflowsDelta)
		}
	}
}

func (w *secWorld) runVersionPin(t *testing.T, c SecCheck, failf func(string, ...any)) {
	t.Helper()
	owner := w.users["owner"]
	v1 := readFixture(t, c.Fixture)
	draft, ver, _ := w.publishRun(t, w.A, owner, v1, false)
	d2, res := w.A.SaveDraft(owner, draft, readFixture(t, c.EditedFixture))
	if res.Status != http.StatusOK && res.Status != http.StatusCreated {
		failf("save edited draft: %d %s", res.Status, res.Body)
		return
	}
	_ = d2
	exec, res := w.A.Start(owner, draft.WorkflowID, ver, nil)
	if res.Status != http.StatusCreated {
		failf("start: %d %s", res.Status, res.Body)
		return
	}
	if err := w.d.Drive(t, w.A); err != nil {
		failf("drive: %v", err)
		return
	}
	run := w.A.Observe(t, exec)
	want := nodeIDs(t, v1)
	got := sortedNodes(run.Steps)
	if c.StepsMatch == "published" && strings.Join(got, ",") != strings.Join(want, ",") {
		failf("run steps %v, want the published version's nodes %v", got, want)
	}
}

func nodeIDs(t *testing.T, src string) []string {
	t.Helper()
	var doc struct {
		Spec struct {
			Nodes []struct {
				ID string `yaml:"id"`
			} `yaml:"nodes"`
		} `yaml:"spec"`
	}
	if err := yamlUnmarshal([]byte(src), &doc); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, n := range doc.Spec.Nodes {
		out = append(out, n.ID)
	}
	sort.Strings(out)
	return out
}

// canaryForms returns the encodings of v the scan looks for.
func canaryForms(v string, forms []string) []string {
	var out []string
	for _, f := range forms {
		switch f {
		case "substring":
			out = append(out, v)
		case "base64":
			out = append(out, base64.StdEncoding.EncodeToString([]byte(v)), base64.RawURLEncoding.EncodeToString([]byte(v)))
		case "urlencoded":
			out = append(out, url.QueryEscape(v))
		}
	}
	return out
}

func (w *secWorld) runCanary(t *testing.T, c SecCheck, failf func(string, ...any), stop func() []Response) {
	t.Helper()
	// Snapshot the capture so far and keep capturing.
	got := stop()
	w.captured = append(w.captured, got...)
	restart := w.env.Capture()
	_ = restart // capture continues for later checks; TestSecurity stops it
	var needles []string
	for _, name := range c.Canaries {
		v, ok := w.vars["canary."+name]
		if !ok {
			failf("canary %s is not seeded by the harness", name)
			continue
		}
		needles = append(needles, canaryForms(v, c.Forms)...)
	}
	hits := 0
	for _, target := range c.Scan {
		switch target {
		case "api":
			for i, r := range w.captured {
				hay := string(r.Body)
				for k, vs := range r.Header {
					hay += "\n" + k + ": " + strings.Join(vs, ",")
				}
				for _, n := range needles {
					if strings.Contains(hay, n) {
						hits++
						failf("api response %d (status %d) contains a canary form", i, r.Status)
					}
				}
			}
			if len(w.captured) == 0 {
				failf("api scan captured no responses")
			}
		case "db":
			rows, err := w.env.admin.Query(w.env.ctx, `
SELECT 'execution_steps (whole row: input/output/error redacted)', row_to_json(s)::text FROM execution_steps s WHERE workspace_id = $1::uuid
UNION ALL SELECT 'execution_jobs (whole row)', row_to_json(j)::text FROM execution_jobs j WHERE workspace_id = $1::uuid
UNION ALL SELECT 'audit_events.details_redacted', coalesce(details_redacted::text, '') FROM audit_events WHERE workspace_id = $1::uuid
UNION ALL SELECT 'executions (whole row)', row_to_json(e)::text FROM executions e WHERE workspace_id = $1::uuid`, w.A.WS.ID)
			if err != nil {
				failf("db scan: %v", err)
				continue
			}
			for rows.Next() {
				var col, val string
				if err := rows.Scan(&col, &val); err != nil {
					failf("db scan: %v", err)
					break
				}
				for _, n := range needles {
					if strings.Contains(val, n) {
						hits++
						failf("db %s contains a canary form", col)
					}
				}
			}
			rows.Close()
		}
	}
	if c.Hits != nil && hits != *c.Hits {
		failf("canary hits = %d, want %d", hits, *c.Hits)
	}
}
