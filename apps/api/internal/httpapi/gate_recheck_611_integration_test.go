package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/jackc/pgx/v5"
)

// Waiting targeted approval gates are re-checked on every change that
// can shrink their decider set, and a gate that parks while such a
// change is in flight resolves its approvers only after it commits.
// Real Postgres; the default (workspaces) SCIM mode server, local APIs.
//
// Race tests use a barrier: an admin-pool transaction holds a row lock
// that the first request reaches mid-transaction (after it took the
// workspace-row lock), so the second request runs while the first is
// in flight. Lock waiters are counted in pg_stat_activity.

type g611 struct {
	t  *testing.T
	th *gmHarness
	w  scimWS
	h  http.Handler
}

func newG611(t *testing.T) *g611 {
	t.Helper()
	th := newGMHarness(t)
	return &g611{t: t, th: th, w: th.workspace(), h: th.ws}
}

func (g *g611) owner() identity.User { return g.th.owner }

// member puts a new user in the workspace with roles (owner acts).
func (g *g611) member(name string, roles ...string) identity.User {
	g.t.Helper()
	subject := g.th.uniq(name)
	rk, _ := json.Marshal(roles)
	m := putMember(g.t, g.h, g.owner(), g.w.tenant, g.w.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":%q,"role_keys":%s}`, scimIssuer, subject, name, rk))
	return identity.User{ID: m.User.ID, Issuer: scimIssuer, ExternalSubject: subject, DisplayName: name}
}

func (g *g611) do(actor identity.User, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	if body == "" {
		g.h.ServeHTTP(rec, workspaceRequest(method, path, nil, actor, g.w.tenant, g.w.ws))
	} else {
		g.h.ServeHTTP(rec, workspaceJSON(method, path, []byte(body), actor, g.w.tenant, g.w.ws))
	}
	return rec
}

// setRoles replaces target's roles through PUT /workspace/members.
func (g *g611) setRoles(actor, target identity.User, roles ...string) *httptest.ResponseRecorder {
	rk, _ := json.Marshal(roles)
	return g.do(actor, http.MethodPut, "/api/v1/workspace/members", fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":%q,"role_keys":%s}`, target.Issuer, target.ExternalSubject, target.DisplayName, rk))
}

func (g *g611) group(name string, members ...identity.User) string {
	g.t.Helper()
	id := g.th.localGroup(g.h, g.w, g.th.uniq(name))
	for _, m := range members {
		if rec := g.addToGroup(id, m); rec.Code != http.StatusNoContent {
			g.t.Fatalf("add member: %d %s", rec.Code, rec.Body.String())
		}
	}
	return id
}

func (g *g611) addToGroup(groupID string, m identity.User) *httptest.ResponseRecorder {
	return g.do(g.owner(), http.MethodPost, "/api/v1/workspace/groups/"+groupID+"/members", `{"userId":"`+m.ID+`"}`)
}

func ids(us ...identity.User) []string {
	out := []string{}
	for _, u := range us {
		out = append(out, u.ID)
	}
	return out
}

// prepare publishes a targeted gate (owner) and starts it as requester.
// The job is queued; claim parks it.
func (g *g611) prepare(requester identity.User, users, groups []string) string {
	g.t.Helper()
	g.th.seq++
	wf := createWorkflow(g.t, g.h, g.owner(), g.w.tenant, g.w.ws, targetedGateYAML(fmt.Sprintf("g611-gate-%d-%d", g.th.n, g.th.seq), users, groups))
	body, _ := json.Marshal(map[string]any{"revision": wf.Draft.Revision, "note": "611"})
	rec := g.do(g.owner(), http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", string(body))
	if rec.Code != http.StatusCreated {
		g.t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	var pub publishResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	return startExecution(g.t, g.h, requester, g.w.tenant, g.w.ws, wf.Workflow.ID, pub.Version.ID).ID
}

func (g *g611) claim(actor identity.User) int {
	g.th.seq++
	return g.do(actor, http.MethodPost, "/api/v1/jobs/claim", fmt.Sprintf(`{"workerId":"g611-%d","leaseSeconds":5}`, g.th.seq)).Code
}

// park prepares and claims a gate, which must start waiting.
func (g *g611) park(requester identity.User, users, groups []string) string {
	g.t.Helper()
	exec := g.prepare(requester, users, groups)
	if code := g.claim(requester); code != http.StatusOK {
		g.t.Fatalf("claim: %d", code)
	}
	if got := g.th.gate(exec); got != "pending" {
		g.t.Fatalf("gate did not park: %q", got)
	}
	return exec
}

func (g *g611) execution(actor identity.User, executionID string) gmExec {
	g.t.Helper()
	rec := g.do(actor, http.MethodGet, "/api/v1/executions/"+executionID, "")
	if rec.Code != http.StatusOK {
		g.t.Fatalf("execution: %d %s", rec.Code, rec.Body.String())
	}
	var e gmExec
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	return e
}

func (g *g611) pending(executionID string) int {
	var n int
	if err := g.th.admin.QueryRow(g.th.ctx, `SELECT count(*) FROM approvals WHERE execution_id = $1::uuid AND status = 'pending'`, executionID).Scan(&n); err != nil {
		g.t.Fatal(err)
	}
	return n
}

// assertWaiting: the gate still has a decider and keeps waiting.
func (g *g611) assertWaiting(actor identity.User, executionID string) {
	g.t.Helper()
	if got := g.th.gate(executionID); got != "pending" {
		g.t.Fatalf("gate = %q, want pending", got)
	}
	if e := g.execution(actor, executionID); e.Status != "waiting" {
		g.t.Fatalf("execution = %+v, want waiting", e)
	}
}

// assertClosed: a waiting gate was closed by the re-check with the
// existing no-eligible-decider wording.
func (g *g611) assertClosed(actor identity.User, executionID string) {
	g.t.Helper()
	got := g.th.scalar(`SELECT status || '|' || COALESCE(close_reason, '') FROM approvals WHERE execution_id = $1::uuid ORDER BY created_at DESC LIMIT 1`, executionID)
	if got != "canceled|requirement_unresolvable" {
		g.t.Fatalf("approval = %q, want canceled|requirement_unresolvable", got)
	}
	cause := g.th.scalar(`
		SELECT COALESCE(e.details->>'reason', '') || '|' || COALESCE(e.details->>'cause', '')
		  FROM approval_events e JOIN approvals a ON a.id = e.approval_id
		 WHERE a.execution_id = $1::uuid AND e.event_type = 'canceled'`, executionID)
	if cause != "requirement_unresolvable|no_eligible_decider" {
		g.t.Fatalf("cancel event = %q", cause)
	}
	g.assertRunFailedNoDecider(actor, executionID)
}

// assertNeverWaiting: the gate parked after the change committed and
// failed at park time (no approval left pending), with the same wording.
func (g *g611) assertNeverWaiting(actor identity.User, executionID string) {
	g.t.Helper()
	if n := g.pending(executionID); n != 0 {
		g.t.Fatalf("%d approval(s) still pending with no eligible decider", n)
	}
	g.assertRunFailedNoDecider(actor, executionID)
}

func (g *g611) assertRunFailedNoDecider(actor identity.User, executionID string) {
	g.t.Helper()
	e := g.execution(actor, executionID)
	if e.Status != "failed" || e.StatusReason != "requirement_unresolvable" || e.StatusReasonDetails["cause"] != "no_eligible_decider" {
		g.t.Fatalf("execution = %+v, want failed requirement_unresolvable / no_eligible_decider", e)
	}
}

// ---- barrier race ----

type g611Barrier struct {
	g  *g611
	tx pgx.Tx
}

func (g *g611) hold(sql string, args ...any) *g611Barrier {
	g.t.Helper()
	tx, err := g.th.admin.Begin(g.th.ctx)
	if err != nil {
		g.t.Fatal(err)
	}
	var one int
	if err := tx.QueryRow(g.th.ctx, sql, args...).Scan(&one); err != nil {
		_ = tx.Rollback(g.th.ctx)
		g.t.Fatalf("barrier %s: %v", sql, err)
	}
	return &g611Barrier{g: g, tx: tx}
}

func (b *g611Barrier) release() {
	if b.tx != nil {
		_ = b.tx.Rollback(b.g.th.ctx)
		b.tx = nil
	}
}

// waitLockWaiters returns true once n backends in this database wait on
// a lock, or false once done fires first.
func (g *g611) waitLockWaiters(n int, done <-chan int) bool {
	g.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if len(done) > 0 {
			return false
		}
		var waiting int
		if err := g.th.admin.QueryRow(g.th.ctx, `
			SELECT count(*) FROM pg_stat_activity
			 WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			g.t.Fatal(err)
		}
		if waiting >= n {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	g.t.Fatalf("timed out waiting for %d lock waiters", n)
	return false
}

type raceResult struct {
	first, second int
	// secondWaited is true when the second request was blocked on a
	// lock while the first was held at the barrier.
	secondWaited bool
}

// race starts first, which must block on the barrier, runs between (if
// any) while first is held, then starts second, releases the barrier,
// and returns both codes.
func (g *g611) race(b *g611Barrier, first func() int, between func(), second func() int) raceResult {
	g.t.Helper()
	defer b.release()
	firstDone := make(chan int, 1)
	go func() { firstDone <- first() }()
	if !g.waitLockWaiters(1, firstDone) {
		g.t.Fatalf("first request did not reach the barrier: %d", <-firstDone)
	}
	if between != nil {
		between()
	}
	secondDone := make(chan int, 1)
	go func() { secondDone <- second() }()
	waited := g.waitLockWaiters(2, secondDone)
	b.release()
	res := raceResult{first: <-firstDone, second: <-secondDone, secondWaited: waited}
	return res
}

// ---- (a) demotion ----

func TestGateRecheckOnDemotion(t *testing.T) {
	type outcome int
	const (
		waiting outcome = iota
		closed
	)
	cases := []struct {
		name string
		// run sets up a parked gate, makes the role change, and returns
		// the execution, a viewer for it, the role change status, and the
		// expected gate outcome.
		run func(g *g611) (exec string, viewer identity.User, code int, wantCode int, want outcome)
	}{
		{"named approver demoted to viewer", func(g *g611) (string, identity.User, int, int, outcome) {
			v := g.member("V", "approver")
			exec := g.park(g.owner(), ids(v), nil)
			return exec, g.owner(), g.setRoles(g.owner(), v, "viewer").Code, http.StatusOK, closed
		}},
		{"group member demoted to viewer", func(g *g611) (string, identity.User, int, int, outcome) {
			v := g.member("V", "approver")
			grp := g.group("G", v)
			exec := g.park(g.owner(), nil, []string{grp})
			return exec, g.owner(), g.setRoles(g.owner(), v, "viewer").Code, http.StatusOK, closed
		}},
		{"another named decider remains", func(g *g611) (string, identity.User, int, int, outcome) {
			v, w := g.member("V", "approver"), g.member("W", "approver")
			exec := g.park(g.owner(), ids(v, w), nil)
			return exec, g.owner(), g.setRoles(g.owner(), v, "viewer").Code, http.StatusOK, waiting
		}},
		{"promotion keeps waiting", func(g *g611) (string, identity.User, int, int, outcome) {
			v := g.member("V", "approver")
			exec := g.park(g.owner(), ids(v), nil)
			return exec, g.owner(), g.setRoles(g.owner(), v, "approver", "operator").Code, http.StatusOK, waiting
		}},
		{"unchanged roles keep waiting", func(g *g611) (string, identity.User, int, int, outcome) {
			v := g.member("V", "approver")
			exec := g.park(g.owner(), ids(v), nil)
			return exec, g.owner(), g.setRoles(g.owner(), v, "approver").Code, http.StatusOK, waiting
		}},
		// Admin fallback. The gate names only an empty group, so it waits
		// only because an active admin other than the requester can
		// override.
		{"admin fallback: two or more other admins left", func(g *g611) (string, identity.User, int, int, outcome) {
			empty := g.group("Empty")
			e := g.member("E", "operator")
			b, _ := g.member("B", "admin"), g.member("C", "admin")
			exec := g.park(e, nil, []string{empty})
			return exec, e, g.setRoles(g.owner(), b, "operator").Code, http.StatusOK, waiting
		}},
		{"admin fallback: one other admin left and they requested the gate", func(g *g611) (string, identity.User, int, int, outcome) {
			empty := g.group("Empty")
			b := g.member("B", "admin")
			exec := g.park(g.owner(), nil, []string{empty})
			return exec, g.owner(), g.setRoles(g.owner(), b, "operator").Code, http.StatusOK, closed
		}},
		{"admin fallback: one other admin left, someone else requested", func(g *g611) (string, identity.User, int, int, outcome) {
			empty := g.group("Empty")
			e := g.member("E", "operator")
			b := g.member("B", "admin")
			exec := g.park(e, nil, []string{empty})
			return exec, e, g.setRoles(g.owner(), b, "operator").Code, http.StatusOK, waiting
		}},
		{"admin fallback: last enabled admin demotion refused (one disabled)", func(g *g611) (string, identity.User, int, int, outcome) {
			empty := g.group("Empty")
			e := g.member("E", "operator")
			b, d := g.member("B", "admin"), g.member("D", "admin")
			exec := g.park(e, nil, []string{empty})
			// The owner stops being an admin and D is disabled: B is the
			// only enabled admin. D's binding no longer satisfies the
			// last-admin guard, so B cannot demote themself and the gate
			// keeps its override decider. (Disabling the last enabled admin
			// instance-wide closes it instead: TestUserDisableRechecksGates.)
			g.th.scalar(`WITH x AS (DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid RETURNING 1) SELECT count(*)::text FROM x`, g.w.ws.ID, g.owner().ID)
			g.th.scalar(`WITH x AS (UPDATE users SET status = 'disabled' WHERE id = $1::uuid RETURNING 1) SELECT count(*)::text FROM x`, d.ID)
			return exec, e, g.setRoles(b, b, "operator").Code, http.StatusConflict, waiting
		}},
		{"admin fallback: last admin binding is refused", func(g *g611) (string, identity.User, int, int, outcome) {
			empty := g.group("Empty")
			e := g.member("E", "operator")
			b := g.member("B", "admin")
			exec := g.park(e, nil, []string{empty})
			g.th.scalar(`WITH x AS (DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid RETURNING 1) SELECT count(*)::text FROM x`, g.w.ws.ID, g.owner().ID)
			return exec, e, g.setRoles(b, b, "operator").Code, http.StatusConflict, waiting
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newG611(t)
			exec, viewer, code, wantCode, want := tc.run(g)
			if code != wantCode {
				t.Fatalf("role change = %d, want %d", code, wantCode)
			}
			if want == closed {
				g.assertClosed(viewer, exec)
			} else {
				g.assertWaiting(viewer, exec)
			}
		})
	}
}

// ---- a2: removal of an admin the gate never names ----

func TestGateRecheckAdminRemovalFallback(t *testing.T) {
	t.Run("one other admin left and they requested the gate", func(t *testing.T) {
		g := newG611(t)
		empty, b := g.group("Empty"), g.member("B", "admin")
		exec := g.park(g.owner(), nil, []string{empty})
		if rec := g.do(g.owner(), http.MethodDelete, "/api/v1/workspace/members/"+b.ID, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("remove: %d %s", rec.Code, rec.Body.String())
		}
		g.assertClosed(g.owner(), exec)
	})
	t.Run("two other admins left", func(t *testing.T) {
		g := newG611(t)
		empty, b := g.group("Empty"), g.member("B", "admin")
		g.member("C", "admin")
		exec := g.park(g.owner(), nil, []string{empty})
		if rec := g.do(g.owner(), http.MethodDelete, "/api/v1/workspace/members/"+b.ID, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("remove: %d %s", rec.Code, rec.Body.String())
		}
		g.assertWaiting(g.owner(), exec)
	})
}

// ---- (c) park racing a removal ----

func TestGateRecheckParkRacingMembershipLoss(t *testing.T) {
	g := newG611(t)
	v := g.member("V", "approver")
	grp := g.group("G", v)
	exec := g.prepare(g.owner(), nil, []string{grp})

	// The removal stops at V's group row, after it holds the workspace
	// row and has deleted V's bindings.
	b := g.hold(`SELECT 1 FROM workspace_group_members WHERE workspace_id = $1::uuid AND group_id = $2::uuid AND user_id = $3::uuid FOR UPDATE`, g.w.ws.ID, grp, v.ID)
	res := g.race(b,
		func() int { return g.do(g.owner(), http.MethodDelete, "/api/v1/workspace/members/"+v.ID, "").Code },
		nil,
		func() int { return g.claim(g.owner()) })
	if res.first != http.StatusNoContent || res.second >= 500 {
		t.Fatalf("remove = %d, claim = %d", res.first, res.second)
	}
	if !res.secondWaited {
		t.Error("the park did not wait for the in-flight removal")
	}
	g.assertNeverWaiting(g.owner(), exec)
	if n := g.th.userGroupRows(g.w, v.ID); n != "0" {
		t.Fatalf("group rows left for removed member: %s", n)
	}
}

func TestGateRecheckParkRacingGroupMemberRemoval(t *testing.T) {
	cases := []struct {
		name  string
		first func(g *g611, grp string, v identity.User) int
	}{
		{"member removal", func(g *g611, grp string, v identity.User) int {
			return g.do(g.owner(), http.MethodDelete, "/api/v1/workspace/groups/"+grp+"/members/"+v.ID, "").Code
		}},
		{"group delete", func(g *g611, grp string, _ identity.User) int {
			return g.do(g.owner(), http.MethodDelete, "/api/v1/workspace/groups/"+grp, "").Code
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newG611(t)
			v := g.member("V", "approver")
			grp := g.group("G", v)
			exec := g.prepare(g.owner(), nil, []string{grp})
			b := g.hold(`SELECT 1 FROM workspace_group_members WHERE workspace_id = $1::uuid AND group_id = $2::uuid AND user_id = $3::uuid FOR UPDATE`, g.w.ws.ID, grp, v.ID)
			res := g.race(b,
				func() int { return tc.first(g, grp, v) },
				nil,
				func() int { return g.claim(g.owner()) })
			if res.first != http.StatusNoContent || res.second >= 500 {
				t.Fatalf("%s = %d, claim = %d", tc.name, res.first, res.second)
			}
			if !res.secondWaited {
				t.Error("the park did not wait for the in-flight group change")
			}
			g.assertNeverWaiting(g.owner(), exec)
		})
	}
}

// ---- (b) add racing a membership loss ----

func TestGateRecheckAddRacingMembershipLoss(t *testing.T) {
	g := newG611(t)
	v := g.member("V", "approver")
	// A waiting gate that names V, so the removal locks its execution;
	// the barrier holds that execution row, stopping the removal after it
	// took the workspace row but before it touched any binding.
	decoy := g.park(g.owner(), ids(v), nil)
	grp := g.group("G")
	exec := g.prepare(g.owner(), nil, []string{grp})

	b := g.hold(`SELECT 1 FROM executions WHERE id = $1::uuid FOR UPDATE`, decoy)
	addCode := 0
	res := g.race(b,
		func() int { return g.do(g.owner(), http.MethodDelete, "/api/v1/workspace/members/"+v.ID, "").Code },
		func() {
			// The add takes no workspace lock: it commits while the
			// removal is held.
			addCode = g.addToGroup(grp, v).Code
		},
		func() int { return g.claim(g.owner()) })
	if addCode != http.StatusNoContent {
		t.Fatalf("add while the removal is in flight = %d", addCode)
	}
	if res.first != http.StatusNoContent || res.second >= 500 {
		t.Fatalf("remove = %d, claim = %d", res.first, res.second)
	}
	if !res.secondWaited {
		t.Error("the park did not wait for the in-flight removal")
	}
	g.assertNeverWaiting(g.owner(), exec)
	g.assertClosed(g.owner(), decoy)
	if n := g.th.userGroupRows(g.w, v.ID); n != "0" {
		t.Fatalf("group row left behind for the removed member: %s", n)
	}
	if rows := g.th.memberRows(grp); rows != "" {
		t.Fatalf("group G still lists %s", rows)
	}
}

// ---- guard: no deadlock under concurrent parks and removals ----

func TestGateRecheckNoDeadlock(t *testing.T) {
	g := newG611(t)
	v := g.member("V", "approver")
	grp := g.group("G", v)
	for round := 0; round < 8; round++ {
		execs := []string{
			g.prepare(g.owner(), nil, []string{grp}),
			g.prepare(g.owner(), ids(v), nil),
			g.prepare(g.owner(), ids(v), []string{grp}),
		}
		var wg sync.WaitGroup
		var mu sync.Mutex
		var codes []string
		record := func(what string, code int) {
			mu.Lock()
			defer mu.Unlock()
			if code >= 500 {
				codes = append(codes, fmt.Sprintf("%s=%d", what, code))
			}
		}
		for i := 0; i < 3; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); record("claim", g.claim(g.owner())) }()
		}
		wg.Add(2)
		go func() { defer wg.Done(); record("demote", g.setRoles(g.owner(), v, "viewer").Code) }()
		go func() {
			defer wg.Done()
			record("group remove", g.do(g.owner(), http.MethodDelete, "/api/v1/workspace/groups/"+grp+"/members/"+v.ID, "").Code)
		}()
		wg.Wait()
		if len(codes) > 0 {
			t.Fatalf("round %d: server errors (deadlock?): %s", round, strings.Join(codes, ", "))
		}
		// Park anything a contended claim skipped; V can no longer decide.
		for i := 0; i < 5 && g.claim(g.owner()) == http.StatusOK; i++ {
		}
		for _, exec := range execs {
			if n := g.pending(exec); n != 0 {
				t.Fatalf("round %d: gate %s still pending with no eligible decider", round, exec)
			}
		}
		if rec := g.setRoles(g.owner(), v, "approver"); rec.Code != http.StatusOK {
			t.Fatalf("restore roles: %d", rec.Code)
		}
		if rec := g.addToGroup(grp, v); rec.Code != http.StatusNoContent {
			t.Fatalf("restore group: %d", rec.Code)
		}
	}
	if strings.Contains(g.th.logs.String(), "40P01") || strings.Contains(g.th.logs.String(), "deadlock detected") {
		t.Fatal("a deadlock was logged")
	}
}
