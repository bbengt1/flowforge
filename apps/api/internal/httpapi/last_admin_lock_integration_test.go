package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/jackc/pgx/v5"
)

// Last-admin guard under concurrency. Each test makes A and B the only
// two administrators of a workspace and races two changes that would each
// leave one admin, but together leave none. The barrier is deterministic:
// a test transaction holds a row lock on A's workspace group row, so the
// first request (removing A) blocks on its group-row delete, which runs
// after its last-admin count, and stays open. The second request starts
// only once the first is waiting. Without the workspace-row lock the
// second request counts A (not yet committed as removed), passes, and
// commits while the first is still held: both succeed and the workspace
// has no admin. With the lock the second request waits for the first,
// then counts zero and is refused.

type lastAdminRace struct {
	th      *scimWSHarness
	w       scimWS
	a, b    string // user ids of the only two admins
	aUser   identity.User
	bUser   identity.User
	barrier pgx.Tx
}

func newLastAdminRace(t *testing.T, th *scimWSHarness, w scimWS, a, b string) *lastAdminRace {
	t.Helper()
	putMember(t, th.h, th.owner, w.tenant, w.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Admin A","role_keys":["admin"]}`, scimIssuer, a))
	putMember(t, th.h, th.owner, w.tenant, w.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Admin B","role_keys":["admin"]}`, scimIssuer, b))
	var aID, bID string
	if err := th.admin.QueryRow(th.ctx, `SELECT id::text FROM users WHERE issuer = $1 AND external_subject = $2`, scimIssuer, a).Scan(&aID); err != nil {
		t.Fatal(err)
	}
	if err := th.admin.QueryRow(th.ctx, `SELECT id::text FROM users WHERE issuer = $1 AND external_subject = $2`, scimIssuer, b).Scan(&bID); err != nil {
		t.Fatal(err)
	}
	th.addToGroup(w, aID)
	// The creator stops being an admin, leaving A and B as the only two.
	// Member-API calls in the race are made by A and B themselves.
	if _, err := th.admin.Exec(th.ctx, `DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, w.ws.ID, th.owner.ID); err != nil {
		t.Fatal(err)
	}
	r := &lastAdminRace{th: th, w: w, a: aID, b: bID,
		aUser: identity.User{ID: aID, Issuer: scimIssuer, ExternalSubject: a, DisplayName: "Admin A"},
		bUser: identity.User{ID: bID, Issuer: scimIssuer, ExternalSubject: b, DisplayName: "Admin B"},
	}
	if n := r.admins(t); n != 2 {
		t.Fatalf("setup admins = %d", n)
	}
	return r
}

func (r *lastAdminRace) admins(t *testing.T) int {
	t.Helper()
	var n int
	if err := r.th.admin.QueryRow(r.th.ctx, `
		SELECT COUNT(DISTINCT b.user_id)
		  FROM workspace_role_bindings b
		  JOIN role_permissions rp ON rp.role_id = b.role_id
		  JOIN permissions p ON p.id = rp.permission_id
		 WHERE b.workspace_id = $1::uuid AND p.key = 'workspace.administer'`, r.w.ws.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// hold takes the barrier: a row lock on A's group row.
func (r *lastAdminRace) hold(t *testing.T) {
	t.Helper()
	tx, err := r.th.admin.Begin(r.th.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var one int
	if err := tx.QueryRow(r.th.ctx, `
		SELECT 1 FROM workspace_group_members
		 WHERE workspace_id = $1::uuid AND user_id = $2::uuid
		 LIMIT 1 FOR UPDATE`, r.w.ws.ID, r.a).Scan(&one); err != nil {
		_ = tx.Rollback(r.th.ctx)
		t.Fatal(err)
	}
	r.barrier = tx
}

func (r *lastAdminRace) release(t *testing.T) {
	t.Helper()
	if r.barrier != nil {
		_ = r.barrier.Rollback(r.th.ctx)
		r.barrier = nil
	}
}

// waitBlocked returns once at least n backends in this database are
// waiting on a lock, or once done has a value (the request finished
// without blocking). It reports whether done fired.
func (r *lastAdminRace) waitBlocked(t *testing.T, n int, done <-chan int) (int, bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case code := <-done:
			return code, true
		default:
		}
		var waiting int
		if err := r.th.admin.QueryRow(r.th.ctx, `
			SELECT count(*) FROM pg_stat_activity
			 WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= n {
			return 0, false
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d lock waiters", n)
	return 0, false
}

// race runs first (which must block on the barrier after its count) and
// then second, releases the barrier, and returns both status codes.
func (r *lastAdminRace) race(t *testing.T, first, second func() int) (int, int) {
	t.Helper()
	r.hold(t)
	defer r.release(t)
	firstDone := make(chan int, 1)
	go func() { firstDone <- first() }()
	if code, done := r.waitBlocked(t, 1, firstDone); done {
		t.Fatalf("first request did not reach the barrier: %d", code)
	}
	secondDone := make(chan int, 1)
	go func() { secondDone <- second() }()
	secondCode, finished := r.waitBlocked(t, 2, secondDone)
	r.release(t)
	firstCode := <-firstDone
	if !finished {
		secondCode = <-secondDone
	}
	return firstCode, secondCode
}

// removeMember has actor remove userID through the members API.
func (r *lastAdminRace) removeMember(actor identity.User, userID string) func() int {
	return func() int {
		rec := httptest.NewRecorder()
		r.th.h.ServeHTTP(rec, workspaceRequest(http.MethodDelete, "/api/v1/workspace/members/"+userID, nil, actor, r.w.tenant, r.w.ws))
		return rec.Code
	}
}

func assertOneWins(t *testing.T, r *lastAdminRace, firstCode, secondCode, firstOK, secondOK int) {
	t.Helper()
	okCount := 0
	if firstCode == firstOK {
		okCount++
	}
	if secondCode == secondOK {
		okCount++
	}
	refused := 0
	for _, c := range []int{firstCode, secondCode} {
		if c == http.StatusConflict {
			refused++
		}
	}
	if okCount != 1 || refused != 1 {
		t.Fatalf("want exactly one success and one 409, got first=%d second=%d (admins left %d)", firstCode, secondCode, r.admins(t))
	}
	if n := r.admins(t); n != 1 {
		t.Fatalf("admins left = %d, want 1", n)
	}
}

// identity.RemoveMember (members API) vs identity.RemoveMember.
func TestLastAdminGuardConcurrentMemberRemovals(t *testing.T) {
	th := newScimWSHarness(t)
	w := th.workspace()
	r := newLastAdminRace(t, th, w, th.uniq("la-a"), th.uniq("la-b"))
	// B removes A (held at the barrier); A removes B.
	first, second := r.race(t, r.removeMember(r.bUser, r.a), r.removeMember(r.aUser, r.b))
	assertOneWins(t, r, first, second, http.StatusNoContent, http.StatusNoContent)
}

// identity.RemoveMember vs identity.SetMemberRoles demoting the other
// admin (PUT /workspace/members with a non-admin role).
func TestLastAdminGuardConcurrentRemovalAndDemotion(t *testing.T) {
	th := newScimWSHarness(t)
	w := th.workspace()
	bSubject := th.uniq("la-demote-b")
	r := newLastAdminRace(t, th, w, th.uniq("la-demote-a"), bSubject)
	demote := func() int {
		rec := httptest.NewRecorder()
		body := fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Admin B","role_keys":["viewer"]}`, scimIssuer, bSubject)
		th.h.ServeHTTP(rec, workspaceJSON(http.MethodPut, "/api/v1/workspace/members", []byte(body), r.aUser, w.tenant, w.ws))
		return rec.Code
	}
	// B removes A (held at the barrier); A demotes B to viewer.
	first, second := r.race(t, r.removeMember(r.bUser, r.a), demote)
	assertOneWins(t, r, first, second, http.StatusNoContent, http.StatusOK)
}

// SCIM workspace token: active:false for A vs DELETE for B.
func TestLastAdminGuardConcurrentScimDeactivateAndDelete(t *testing.T) {
	th := newScimWSHarness(t)
	w := th.workspace()
	_, tok := th.mint(w, "IdP")
	aSubject, bSubject := th.uniq("la-scim-a"), th.uniq("la-scim-b")
	th.postUser(tok, scimUserJSON(aSubject, "", "Admin A"))
	th.postUser(tok, scimUserJSON(bSubject, "", "Admin B"))
	r := newLastAdminRace(t, th, w, aSubject, bSubject)
	deactivateA := func() int {
		return th.scim(tok, http.MethodPatch, "/scim/v2/Users/"+r.a,
			`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}`).Code
	}
	deleteB := func() int {
		return th.scim(tok, http.MethodDelete, "/scim/v2/Users/"+r.b, "").Code
	}
	first, second := r.race(t, deactivateA, deleteB)
	assertOneWins(t, r, first, second, http.StatusOK, http.StatusNoContent)
}
