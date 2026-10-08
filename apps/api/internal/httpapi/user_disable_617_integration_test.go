package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// An instance-wide disable (instance SCIM bearer, machine-principal
// revoke) re-checks waiting targeted gates in every workspace where the
// person holds a role; the last-admin guard counts enabled admins; and
// every role change or removal writes one audit row in the same
// transaction. Real Postgres, the workspaces-mode server, -p 1.
//
// Fixtures that need a disabled user without the post-disable re-check
// set users.status directly through the admin pool (tests only; the
// production writer is identity SetUserStatus).

type d617 struct {
	*g611
	userNames map[string]string
}

func newD617(t *testing.T) *d617 {
	return &d617{g611: newG611(t), userNames: map[string]string{}}
}

// sibling is a second workspace with the same owner and server.
func (d *d617) sibling() *d617 {
	return &d617{g611: &g611{t: d.t, th: d.th, w: d.th.workspace(), h: d.h}, userNames: d.userNames}
}

// scimUser creates a user through the instance SCIM bearer (so it has an
// instance SCIM link) and grants roles in d's workspace when given.
func (d *d617) scimUser(name string, roles ...string) identity.User {
	d.t.Helper()
	ext, userName := d.th.uniq("ext617"), d.th.uniq("u617")
	rec := d.th.scim(d.h, scimTestToken, http.MethodPost, "/scim/v2/Users", scimUserJSON(userName, ext, name))
	if rec.Code != http.StatusCreated {
		d.t.Fatalf("instance post user: %d %s", rec.Code, rec.Body.String())
	}
	u := identity.User{ID: decodeScimUser(d.t, rec).ID, Issuer: scimIssuer, ExternalSubject: ext, DisplayName: name}
	d.userNames[u.ID] = userName
	if len(roles) > 0 {
		d.grant(u, roles...)
	}
	return u
}

func (d *d617) grant(u identity.User, roles ...string) {
	d.t.Helper()
	rk, _ := json.Marshal(roles)
	putMember(d.t, d.h, d.owner(), d.w.tenant, d.w.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":%q,"role_keys":%s}`, u.Issuer, u.ExternalSubject, u.DisplayName, rk))
}

func (d *d617) instance(method, path, body string) int {
	return d.th.scim(d.h, scimTestToken, method, path, body).Code
}

func activePatch(active bool) string {
	return fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":%t}]}`, active)
}

func (d *d617) patchActive(u identity.User, active bool) int {
	return d.instance(http.MethodPatch, "/scim/v2/Users/"+u.ID, activePatch(active))
}

func (d *d617) putActive(u identity.User, active bool) int {
	body := fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":%q,"externalId":%q,"displayName":%q,"active":%t}`, d.userNames[u.ID], u.ExternalSubject, u.DisplayName, active)
	return d.instance(http.MethodPut, "/scim/v2/Users/"+u.ID, body)
}

// dropOwner removes the owner's admin binding so the fixture's admins
// are the only ones. Call it after everything the owner must do.
func (d *d617) dropOwner() {
	d.th.scalar(`WITH x AS (DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid RETURNING 1) SELECT count(*)::text FROM x`, d.w.ws.ID, d.owner().ID)
}

// setStatusSQL changes users.status without the post-disable re-check.
func (d *d617) setStatusSQL(u identity.User, status string) {
	d.th.scalar(`WITH x AS (UPDATE users SET status = $2 WHERE id = $1::uuid RETURNING 1) SELECT count(*)::text FROM x`, u.ID, status)
}

func (d *d617) machineApprover(name string) (identity.User, string) {
	d.t.Helper()
	client := strings.ToLower(d.th.uniq("mach"))
	rec := d.do(d.owner(), http.MethodPost, "/api/v1/machine/principals", fmt.Sprintf(`{"display_name":%q,"client_id":%q,"secret":%q,"grants":[]}`, name, client, machineTestSecret))
	if rec.Code != http.StatusCreated {
		d.t.Fatalf("machine principal: %d %s", rec.Code, rec.Body.String())
	}
	var v machine.View
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	m := putMember(d.t, d.h, d.owner(), d.w.tenant, d.w.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":%q,"role_keys":["approver"]}`, machine.Issuer, client, name))
	return identity.User{ID: m.User.ID, Issuer: machine.Issuer, ExternalSubject: client, DisplayName: name}, v.ID
}

func (d *d617) approvalID(executionID string) string {
	return d.th.scalar(`SELECT id::text FROM approvals WHERE execution_id = $1::uuid ORDER BY created_at DESC LIMIT 1`, executionID)
}

// ---- (a) instance-wide disable re-checks gates ----

func TestUserDisableRechecksGates(t *testing.T) {
	type outcome int
	const (
		waiting outcome = iota
		closed
	)
	cases := []struct {
		name string
		run  func(d *d617) (exec string, viewer identity.User, code, wantCode int, want outcome)
	}{
		{"PATCH active:false: sole admin was the only named decider", func(d *d617) (string, identity.User, int, int, outcome) {
			e, v := d.member("E", "operator"), d.scimUser("V", "admin")
			exec := d.park(e, ids(v), nil)
			d.dropOwner()
			return exec, e, d.patchActive(v, false), http.StatusOK, closed
		}},
		{"DELETE: sole admin was the override fallback", func(d *d617) (string, identity.User, int, int, outcome) {
			empty := d.group("Empty")
			e, v := d.member("E", "operator"), d.scimUser("V", "admin")
			exec := d.park(e, nil, []string{empty})
			d.dropOwner()
			return exec, e, d.instance(http.MethodDelete, "/scim/v2/Users/"+v.ID, ""), http.StatusNoContent, closed
		}},
		{"POST active:false links an existing sole admin", func(d *d617) (string, identity.User, int, int, outcome) {
			e, v := d.member("E", "operator"), d.member("V", "admin")
			exec := d.park(e, ids(v), nil)
			d.dropOwner()
			body := strings.Replace(scimUserJSON(d.th.uniq("u617"), v.ExternalSubject, "V"), `"active":true`, `"active":false`, 1)
			return exec, e, d.instance(http.MethodPost, "/scim/v2/Users", body), http.StatusCreated, closed
		}},
		{"PUT active:false: sole admin was the only named decider", func(d *d617) (string, identity.User, int, int, outcome) {
			e, v := d.member("E", "operator"), d.scimUser("V", "admin")
			exec := d.park(e, ids(v), nil)
			d.dropOwner()
			return exec, e, d.putActive(v, false), http.StatusOK, closed
		}},
		{"revoked machine principal was the only named approver", func(d *d617) (string, identity.User, int, int, outcome) {
			m, id := d.machineApprover("Bot")
			exec := d.park(d.owner(), ids(m), nil)
			return exec, d.owner(), d.do(d.owner(), http.MethodPost, "/api/v1/machine/principals/"+id+"/revoke", "").Code, http.StatusOK, closed
		}},
		{"another named decider remains", func(d *d617) (string, identity.User, int, int, outcome) {
			e, v, w := d.member("E", "operator"), d.scimUser("V", "approver"), d.member("W", "approver")
			exec := d.park(e, ids(v, w), nil)
			return exec, e, d.patchActive(v, false), http.StatusOK, waiting
		}},
		{"non-admin named approver (membership removal re-checks too)", func(d *d617) (string, identity.User, int, int, outcome) {
			v := d.scimUser("V", "approver")
			exec := d.park(d.owner(), ids(v), nil)
			return exec, d.owner(), d.patchActive(v, false), http.StatusOK, closed
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newD617(t)
			exec, viewer, code, wantCode, want := c.run(d)
			if code != wantCode {
				t.Fatalf("disable = %d, want %d", code, wantCode)
			}
			if want == closed {
				d.assertClosed(viewer, exec)
			} else {
				d.assertWaiting(viewer, exec)
			}
		})
	}
}

func TestUserDisableRechecksEveryWorkspaceAndReenableReopensNothing(t *testing.T) {
	d1 := newD617(t)
	d2 := d1.sibling()
	v := d1.scimUser("V", "admin")
	d2.grant(v, "admin")
	e1, e2 := d1.member("E1", "operator"), d2.member("E2", "operator")
	x1, x2 := d1.park(e1, ids(v), nil), d2.park(e2, ids(v), nil)
	d1.dropOwner()
	d2.dropOwner()
	if code := d1.patchActive(v, false); code != http.StatusOK {
		t.Fatalf("disable = %d", code)
	}
	d1.assertClosed(e1, x1)
	d2.assertClosed(e2, x2)
	if code := d1.patchActive(v, true); code != http.StatusOK {
		t.Fatalf("re-enable = %d", code)
	}
	d1.assertClosed(e1, x1)
	d2.assertClosed(e2, x2)
}

type noAdminRow struct {
	actor   string // actor_id, "" when NULL
	details map[string]any
}

func (d *d617) noEnabledAdminRows() []noAdminRow {
	d.t.Helper()
	rows, err := d.th.admin.Query(d.th.ctx, `
		SELECT COALESCE(actor_id::text, ''), resource_type, COALESCE(resource_id::text, ''), details_redacted
		  FROM audit_events WHERE workspace_id = $1::uuid AND action = 'workspace.no_enabled_admin'`, d.w.ws.ID)
	if err != nil {
		d.t.Fatal(err)
	}
	defer rows.Close()
	var out []noAdminRow
	for rows.Next() {
		var r noAdminRow
		var rt, rid string
		if err := rows.Scan(&r.actor, &rt, &rid, &r.details); err != nil {
			d.t.Fatal(err)
		}
		if rt != "workspace" || rid != d.w.ws.ID {
			d.t.Fatalf("row resource=%s/%s", rt, rid)
		}
		out = append(out, r)
	}
	return out
}

// Every disable path records its actor on the row, like a role-change
// row: via scim_instance_token for the instance SCIM bearer (no
// actor_id), the revoking platform admin (actor_id and
// actorDisplayName, no via) for a machine revoke. Details hold only the
// disabled user's UUID and display name plus that actor.
func TestUserDisableAuditsNoEnabledAdmin(t *testing.T) {
	instanceVia := map[string]any{"via": "scim_instance_token"}
	cases := []struct {
		name string
		// run disables the workspace's only enabled admin and returns
		// them, the response code, the wanted code, and the actor fields.
		run func(d *d617) (target identity.User, code, want int, actorID string, actor map[string]any)
	}{
		{"instance PATCH active:false", func(d *d617) (identity.User, int, int, string, map[string]any) {
			v := d.scimUser("Vera Admin", "admin")
			d.dropOwner()
			return v, d.patchActive(v, false), http.StatusOK, "", instanceVia
		}},
		{"instance PUT active:false", func(d *d617) (identity.User, int, int, string, map[string]any) {
			v := d.scimUser("Vera Admin", "admin")
			d.dropOwner()
			return v, d.putActive(v, false), http.StatusOK, "", instanceVia
		}},
		{"instance POST active:false", func(d *d617) (identity.User, int, int, string, map[string]any) {
			v := d.member("Vera Admin", "admin")
			d.dropOwner()
			body := strings.Replace(scimUserJSON(d.th.uniq("u617"), v.ExternalSubject, "Vera Admin"), `"active":true`, `"active":false`, 1)
			return v, d.instance(http.MethodPost, "/scim/v2/Users", body), http.StatusCreated, "", instanceVia
		}},
		{"instance DELETE", func(d *d617) (identity.User, int, int, string, map[string]any) {
			v := d.scimUser("Vera Admin", "admin")
			d.dropOwner()
			return v, d.instance(http.MethodDelete, "/scim/v2/Users/"+v.ID, ""), http.StatusNoContent, "", instanceVia
		}},
		{"machine principal revoke", func(d *d617) (identity.User, int, int, string, map[string]any) {
			m, id := d.machineApprover("Vera Admin")
			d.grant(m, "admin")
			d.dropOwner()
			actor := map[string]any{}
			if n := d.owner().DisplayName; n != "" && !strings.Contains(n, "@") {
				actor["actorDisplayName"] = n
			}
			return m, d.do(d.owner(), http.MethodPost, "/api/v1/machine/principals/"+id+"/revoke", "").Code, http.StatusOK, d.owner().ID, actor
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newD617(t)
			v, code, want, actorID, actor := c.run(d)
			if code != want {
				t.Fatalf("disable = %d, want %d", code, want)
			}
			rows := d.noEnabledAdminRows()
			if len(rows) != 1 {
				t.Fatalf("rows = %v, want one", rows)
			}
			wantDetails := map[string]any{"userId": v.ID, "displayName": "Vera Admin"}
			for k, val := range actor {
				wantDetails[k] = val
			}
			if rows[0].actor != actorID || fmt.Sprint(rows[0].details) != fmt.Sprint(wantDetails) {
				t.Fatalf("row actor=%q details=%v, want actor=%q details=%v", rows[0].actor, rows[0].details, actorID, wantDetails)
			}
		})
	}
}

// A repeat disable writes no second row, a workspace that keeps an
// enabled admin gets none, and a display name shaped like an email is
// left out.
func TestUserDisableNoEnabledAdminRowDedupAndRedaction(t *testing.T) {
	d := newD617(t)
	other := d.sibling()
	v := d.scimUser("Vera Admin", "admin")
	other.grant(v, "admin") // other keeps the owner as an enabled admin
	d.dropOwner()
	for i := 0; i < 2; i++ {
		if code := d.patchActive(v, false); code != http.StatusOK {
			t.Fatalf("disable %d = %d", i, code)
		}
	}
	if rows := d.noEnabledAdminRows(); len(rows) != 1 {
		t.Fatalf("rows = %v, want one", rows)
	}
	if got := other.noEnabledAdminRows(); len(got) != 0 {
		t.Fatalf("workspace with an enabled admin got %v", got)
	}
	third := d.sibling()
	w := third.scimUser("w.admin@example.com", "admin")
	third.dropOwner()
	if code := third.patchActive(w, false); code != http.StatusOK {
		t.Fatalf("disable = %d", code)
	}
	rows := third.noEnabledAdminRows()
	if len(rows) != 1 || fmt.Sprint(rows[0].details) != fmt.Sprint(map[string]any{"userId": w.ID, "via": "scim_instance_token"}) {
		t.Fatalf("details = %v, want userId and via only", rows)
	}
}

// Condition 1: the re-check runs on every disable, so a retry finishes
// what a failed run left.
func TestUserDisableRetryAfterPartialFailure(t *testing.T) {
	d1 := newD617(t)
	d2 := d1.sibling()
	v := d1.scimUser("V", "admin")
	d2.grant(v, "admin")
	e1, e2 := d1.member("E1", "operator"), d2.member("E2", "operator")
	x1, x2 := d1.park(e1, ids(v), nil), d2.park(e2, ids(v), nil)
	d1.dropOwner()
	d2.dropOwner()
	first, second := d1, d2
	if d2.w.ws.ID < d1.w.ws.ID {
		first, second = d2, d1
	}
	firstExec, secondExec := x1, x2
	firstViewer := e1
	if first == d2 {
		firstExec, secondExec, firstViewer = x2, x1, e2
	}
	token := d1.liveSession(v)
	restore := installDisableRecheckHook(func(ws string) error {
		if ws == second.w.ws.ID {
			return errors.New("injected re-check failure")
		}
		return nil
	})
	if restore == nil {
		t.Skip("needs the re-check test hook")
	}
	code := d1.patchActive(v, false)
	restore()
	if code < 500 {
		t.Fatalf("disable with a failing workspace = %d, want 5xx", code)
	}
	// The account is disabled even though the re-check failed part way:
	// its sessions are revoked and the error asks the IdP to retry.
	if d1.sessionAlive(token) {
		t.Fatal("session still live after a disable whose re-check failed")
	}
	first.assertClosed(firstViewer, firstExec)
	if got := d1.th.gate(secondExec); got != "pending" {
		t.Fatalf("second workspace gate = %q before retry", got)
	}
	if code := d1.patchActive(v, false); code != http.StatusOK {
		t.Fatalf("retry = %d", code)
	}
	if got := d1.th.gate(secondExec); got != "canceled" {
		t.Fatalf("second workspace gate = %q after retry", got)
	}
}

// A machine revoke whose re-check fails still revokes the principal's
// sessions, reports 503, and a repeat revoke finishes the re-check.
func TestMachineRevokeRecheckFailureStillRevokesSessions(t *testing.T) {
	d := newD617(t)
	m, id := d.machineApprover("Bot")
	exec := d.park(d.owner(), ids(m), nil)
	token := d.liveSession(m)
	restore := installDisableRecheckHook(func(string) error { return errors.New("injected re-check failure") })
	if restore == nil {
		t.Skip("needs the re-check test hook")
	}
	code := d.do(d.owner(), http.MethodPost, "/api/v1/machine/principals/"+id+"/revoke", "").Code
	restore()
	if code != http.StatusServiceUnavailable {
		t.Fatalf("revoke with a failing re-check = %d, want 503", code)
	}
	if d.sessionAlive(token) {
		t.Fatal("machine session still live after a revoke whose re-check failed")
	}
	if got := d.th.gate(exec); got != "pending" {
		t.Fatalf("gate = %q before the repeat", got)
	}
	if rec := d.do(d.owner(), http.MethodPost, "/api/v1/machine/principals/"+id+"/revoke", ""); rec.Code != http.StatusOK && rec.Code != http.StatusConflict {
		t.Fatalf("repeat revoke = %d %s", rec.Code, rec.Body.String())
	}
	d.assertClosed(d.owner(), exec)
}

func (d *d617) liveSession(u identity.User) string {
	d.t.Helper()
	issued, err := session.NewPostgres(d.th.pool).Create(d.th.ctx, u.ID, time.Now(), time.Hour, 8*time.Hour)
	if err != nil {
		d.t.Fatal(err)
	}
	if !d.sessionAlive(issued.Token) {
		d.t.Fatal("new session is not live")
	}
	return issued.Token
}

func (d *d617) sessionAlive(token string) bool {
	_, err := session.NewPostgres(d.th.pool).Lookup(d.th.ctx, token, time.Now())
	return err == nil
}

// Condition 3 backstop: the status commits, the re-check never runs (a
// crash), and boot resync closes the gate.
func TestUserDisableResyncBackstop(t *testing.T) {
	d := newD617(t)
	e, v := d.member("E", "operator"), d.scimUser("V", "admin")
	exec := d.park(e, ids(v), nil)
	d.dropOwner()
	restore := installDisableRecheckHook(func(string) error { return errors.New("crash before re-check") })
	if restore == nil {
		t.Skip("needs the re-check test hook")
	}
	code := d.patchActive(v, false)
	restore()
	if code < 500 {
		t.Fatalf("disable = %d, want 5xx", code)
	}
	if got := d.th.scalar(`SELECT status FROM users WHERE id = $1::uuid`, v.ID); got != "disabled" {
		t.Fatalf("status = %q", got)
	}
	if got := d.th.gate(exec); got != "pending" {
		t.Fatalf("gate = %q before resync", got)
	}
	approval.ResyncOpenApprovals(d.th.ctx, d.th.pool, wfstore.NewPostgres(d.th.pool), opsconfig.NewPostgres(d.th.pool), slog.New(slog.NewTextHandler(io.Discard, nil)))
	d.assertClosed(e, exec)
}

// Condition 3: decide re-reads the decider's status in its own
// transaction. The decide passes request authentication, waits on the
// approval row, the status commits (no re-check runs), then decide must
// refuse.
func TestDecideRefusesDeciderDisabledMidDecide(t *testing.T) {
	d := newD617(t)
	v := d.member("V", "approver")
	exec := d.park(d.owner(), ids(v), nil)
	id := d.approvalID(exec)
	b := d.hold(`SELECT 1 FROM approvals WHERE id = $1::uuid FOR UPDATE`, id)
	done := make(chan int, 1)
	go func() {
		done <- d.do(v, http.MethodPost, "/api/v1/approvals/"+id+"/decide", `{"decision":"approved"}`).Code
	}()
	if !d.waitLockWaiters(1, done) {
		b.release()
		t.Fatalf("decide did not reach the approval lock: %d", <-done)
	}
	d.setStatusSQL(v, "disabled")
	b.release()
	if code := <-done; code != http.StatusForbidden {
		t.Fatalf("decide by a disabled user = %d, want 403", code)
	}
	if got := d.th.gate(exec); got != "pending" {
		t.Fatalf("approval = %q, want still pending", got)
	}
}

// Condition 2: both orderings of a park and an instance-wide disable.
func TestUserDisableRacingPark(t *testing.T) {
	t.Run("park read the user as active before the disable committed", func(t *testing.T) {
		d := newD617(t)
		e, v := d.member("E", "operator"), d.scimUser("V", "admin")
		exec := d.prepare(e, ids(v), nil)
		d.dropOwner()
		// Block the park after it resolved its approvers: the approval
		// insert's foreign-key check waits on the workflow version.
		b := d.hold(`SELECT 1 FROM workflow_versions WHERE id = (SELECT workflow_version_id FROM executions WHERE id = $1::uuid) FOR UPDATE`, exec)
		res := d.race(b, func() int { return d.claim(e) }, nil, func() int { return d.patchActive(v, false) })
		if res.first != http.StatusOK || res.second != http.StatusOK {
			t.Fatalf("claim = %d, disable = %d", res.first, res.second)
		}
		if !res.secondWaited {
			t.Fatal("the disable's re-check did not wait for the in-flight park")
		}
		d.assertClosed(e, exec)
	})
	t.Run("park starts after the disable committed", func(t *testing.T) {
		d := newD617(t)
		e, v := d.member("E", "operator"), d.scimUser("V", "admin")
		exec := d.prepare(e, ids(v), nil)
		d.dropOwner()
		if code := d.patchActive(v, false); code != http.StatusOK {
			t.Fatalf("disable = %d", code)
		}
		// The park resolves the requirement, sees the named approver is
		// disabled, and fails the gate closed (403 from the claim).
		if code := d.claim(e); code != http.StatusForbidden {
			t.Fatalf("claim = %d, want 403 (requirement unresolvable)", code)
		}
		if n := d.pending(exec); n != 0 {
			t.Fatalf("%d approval(s) pending after the disable committed", n)
		}
		if x := d.execution(e, exec); x.Status != "failed" || x.StatusReason != "requirement_unresolvable" {
			t.Fatalf("execution = %+v, want failed requirement_unresolvable", x)
		}
	})
}

// ---- (b) the last-admin guard counts enabled admins ----

func TestLastAdminGuardIgnoresDisabledAdmins(t *testing.T) {
	cases := []struct {
		name string
		run  func(d *d617) (code, want int)
	}{
		{"DELETE the last enabled admin while a disabled admin remains", func(d *d617) (int, int) {
			a, x := d.member("A", "admin"), d.member("X", "admin")
			d.setStatusSQL(x, "disabled")
			d.dropOwner()
			return d.do(a, http.MethodDelete, "/api/v1/workspace/members/"+a.ID, "").Code, http.StatusConflict
		}},
		{"demote the last enabled admin while a disabled admin remains", func(d *d617) (int, int) {
			a, x := d.member("A", "admin"), d.member("X", "admin")
			d.setStatusSQL(x, "disabled")
			d.dropOwner()
			return d.setRoles(a, a, "operator").Code, http.StatusConflict
		}},
		{"workspace token deactivates the last enabled admin", func(d *d617) (int, int) {
			a, x := d.member("A", "admin"), d.member("X", "admin")
			d.setStatusSQL(x, "disabled")
			_, tok := d.th.mint(d.w)
			rec := d.th.scim(d.h, tok, http.MethodPost, "/scim/v2/Users", scimUserJSON(d.th.uniq("a"), a.ExternalSubject, "A"))
			if rec.Code != http.StatusCreated {
				d.t.Fatalf("link: %d %s", rec.Code, rec.Body.String())
			}
			d.dropOwner()
			return d.th.scim(d.h, tok, http.MethodPatch, "/scim/v2/Users/"+a.ID, activePatch(false)).Code, http.StatusConflict
		}},
		{"DELETE a disabled admin while an enabled admin remains", func(d *d617) (int, int) {
			x := d.member("X", "admin")
			d.setStatusSQL(x, "disabled")
			return d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/members/"+x.ID, "").Code, http.StatusNoContent
		}},
		{"workspace token removes a non-admin where every admin is disabled", func(d *d617) (int, int) {
			x := d.member("X", "admin")
			_, tok := d.th.mint(d.w)
			rec := d.th.scim(d.h, tok, http.MethodPost, "/scim/v2/Users", scimUserJSON(d.th.uniq("n"), d.th.uniq("n-ext"), "N"))
			if rec.Code != http.StatusCreated {
				d.t.Fatalf("post: %d %s", rec.Code, rec.Body.String())
			}
			n := decodeScimUser(d.t, rec).ID
			d.setStatusSQL(x, "disabled")
			d.dropOwner()
			return d.th.scim(d.h, tok, http.MethodDelete, "/scim/v2/Users/"+n, "").Code, http.StatusNoContent
		}},
		{"removing the only admin role holder is refused", func(d *d617) (int, int) {
			return d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/members/"+d.owner().ID, "").Code, http.StatusConflict
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if code, want := c.run(newD617(t)); code != want {
				t.Fatalf("code = %d, want %d", code, want)
			}
		})
	}
}

// Two enabled admins remove each other while a disabled admin remains.
// The workspace lock serializes the guard: exactly one wins.
func TestLastEnabledAdminConcurrentRemovals(t *testing.T) {
	d := newD617(t)
	a1, a2, x := d.member("A1", "admin"), d.member("A2", "admin"), d.member("X", "admin")
	d.setStatusSQL(x, "disabled")
	d.dropOwner()
	b := d.hold(`SELECT 1 FROM workspaces WHERE id = $1::uuid FOR SHARE`, d.w.ws.ID)
	res := d.race(b,
		func() int { return d.do(a1, http.MethodDelete, "/api/v1/workspace/members/"+a2.ID, "").Code },
		nil,
		func() int { return d.do(a2, http.MethodDelete, "/api/v1/workspace/members/"+a1.ID, "").Code })
	codes := []int{res.first, res.second}
	sort.Ints(codes)
	if codes[0] != http.StatusNoContent || codes[1] != http.StatusConflict || !res.secondWaited {
		t.Fatalf("codes = %v waited = %v, want one 204 and one 409", codes, res.secondWaited)
	}
	n := d.th.scalar(`
		SELECT count(DISTINCT b.user_id)::text FROM workspace_role_bindings b
		  JOIN roles r ON r.id = b.role_id JOIN users u ON u.id = b.user_id
		 WHERE b.workspace_id = $1::uuid AND r.key = 'admin' AND u.status = 'active'`, d.w.ws.ID)
	if n != "1" {
		t.Fatalf("enabled admins left = %s", n)
	}
}

// Many disables, enables, parks and role changes at once: no deadlock,
// no 5xx, and no gate left waiting without an eligible decider.
func TestUserDisableNoDeadlock(t *testing.T) {
	d1 := newD617(t)
	d2 := d1.sibling()
	v := d1.scimUser("V", "approver")
	d2.grant(v, "approver")
	w1, w2 := d1.member("W", "approver"), d2.member("W2", "approver")
	grp := d1.group("G", w1)
	for round := 0; round < 6; round++ {
		var execs []string
		for i := 0; i < 2; i++ {
			execs = append(execs, d1.prepare(d1.owner(), ids(v), []string{grp}), d2.prepare(d2.owner(), ids(v), nil))
		}
		errs := make(chan string, 16)
		run := func(name string, f func() int) {
			code := f()
			if code >= 500 {
				errs <- fmt.Sprintf("%s = %d", name, code)
			}
			errs <- ""
		}
		go run("claim1", func() int { return d1.claim(d1.owner()) })
		go run("claim2", func() int { return d2.claim(d2.owner()) })
		go run("claim3", func() int { return d1.claim(d1.owner()) })
		go run("disable", func() int { return d1.patchActive(v, false) })
		go run("demote", func() int { return d2.setRoles(d2.owner(), w2, "viewer").Code })
		go run("group remove", func() int {
			return d1.do(d1.owner(), http.MethodDelete, "/api/v1/workspace/groups/"+grp+"/members/"+w1.ID, "").Code
		})
		for i := 0; i < 6; i++ {
			if msg := <-errs; msg != "" {
				t.Fatalf("round %d: %s", round, msg)
			}
		}
		for _, x := range execs {
			if d1.th.gate(x) == "pending" {
				// Pending is fine only while a decider exists: v is
				// disabled, so the group's member must still be live.
				if d1.th.scalar(`SELECT count(*)::text FROM workspace_group_members WHERE group_id = $1::uuid`, grp) == "0" {
					t.Fatalf("round %d: gate %s pending with no eligible decider", round, x)
				}
			}
		}
		if logs := d1.th.logs.String(); strings.Contains(logs, "40P01") {
			t.Fatalf("deadlock detected: %s", logs)
		}
		// Reset for the next round.
		if code := d1.patchActive(v, true); code != http.StatusOK {
			t.Fatalf("enable = %d", code)
		}
		d1.grant(v, "approver")
		d2.grant(v, "approver")
		d2.grant(w2, "approver")
		if rec := d1.addToGroup(grp, w1); rec.Code != http.StatusNoContent {
			t.Fatalf("re-add: %d", rec.Code)
		}
	}
}

// ---- #622: one audit row per role change or removal ----

type memberAudit struct {
	Action  string
	ActorID string
	Details map[string]any
}

func (d *d617) memberAudits(userID string) []memberAudit {
	d.t.Helper()
	rows, err := d.th.admin.Query(d.th.ctx, `
		SELECT action, COALESCE(actor_id::text, ''), details_redacted FROM audit_events
		 WHERE workspace_id = $1::uuid AND resource_type = 'workspace_member' AND resource_id = $2::uuid
		 ORDER BY occurred_at, id`, d.w.ws.ID, userID)
	if err != nil {
		d.t.Fatal(err)
	}
	defer rows.Close()
	var out []memberAudit
	for rows.Next() {
		var a memberAudit
		if err := rows.Scan(&a.Action, &a.ActorID, &a.Details); err != nil {
			d.t.Fatal(err)
		}
		out = append(out, a)
	}
	return out
}

func rolesOf(v any) string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, x := range list {
		out = append(out, fmt.Sprint(x))
	}
	return strings.Join(out, ",")
}

// want describes one expected row: action, roles before -> after, and the
// actor ("user:<uuid>", "scim_token:<token id>", "scim_instance_token").
type wantAudit struct{ action, before, after, actor string }

func (d *d617) checkAudits(got []memberAudit, want []wantAudit, targetName string) {
	d.t.Helper()
	if len(got) != len(want) {
		d.t.Fatalf("audit rows = %+v, want %d", got, len(want))
	}
	for i, w := range want {
		g := got[i]
		if g.Action != w.action || rolesOf(g.Details["rolesBefore"]) != w.before || rolesOf(g.Details["rolesAfter"]) != w.after {
			d.t.Fatalf("row %d = %+v, want %+v", i, g, w)
		}
		if targetName != "" && g.Details["displayName"] != targetName {
			d.t.Fatalf("row %d displayName = %v, want %q", i, g.Details["displayName"], targetName)
		}
		var actor string
		switch {
		case g.ActorID != "":
			actor = "user:" + g.ActorID
			if g.Details["actorDisplayName"] == nil {
				d.t.Fatalf("row %d has no actor display name: %+v", i, g)
			}
		case g.Details["via"] == "scim_token":
			actor = "scim_token:" + fmt.Sprint(g.Details["tokenId"])
		default:
			actor = fmt.Sprint(g.Details["via"])
		}
		if actor != w.actor {
			d.t.Fatalf("row %d actor = %q, want %q", i, actor, w.actor)
		}
	}
}

func TestMemberRoleChangesAreAudited(t *testing.T) {
	const change, remove = "workspace_member.roles_change", "workspace_member.remove"
	cases := []struct {
		name string
		// setup prepares the target and returns the change to make, its
		// wanted status, and the rows the change itself must add.
		setup func(d *d617) (target identity.User, act func() int, wantCode int, want []wantAudit)
	}{
		{"PUT approver to viewer (session)", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			v := d.member("Vic", "approver")
			return v, func() int { return d.setRoles(d.owner(), v, "viewer").Code }, http.StatusOK, []wantAudit{{change, "approver", "viewer", "user:" + d.owner().ID}}
		}},
		{"PUT admin demotion (session)", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			v := d.member("Vic", "admin")
			return v, func() int { return d.setRoles(d.owner(), v, "operator").Code }, http.StatusOK, []wantAudit{{change, "admin", "operator", "user:" + d.owner().ID}}
		}},
		{"PUT unchanged roles writes nothing", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			v := d.member("Vic", "approver")
			return v, func() int { return d.setRoles(d.owner(), v, "approver").Code }, http.StatusOK, nil
		}},
		{"PUT refused last-admin demotion writes nothing", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			return d.owner(), func() int { return d.setRoles(d.owner(), d.owner(), "viewer").Code }, http.StatusConflict, nil
		}},
		{"DELETE member (session)", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			v := d.member("Vic", "approver")
			return v, func() int { return d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/members/"+v.ID, "").Code }, http.StatusNoContent, []wantAudit{{remove, "approver", "", "user:" + d.owner().ID}}
		}},
		{"DELETE refused last admin writes nothing", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			return d.owner(), func() int {
				return d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/members/"+d.owner().ID, "").Code
			}, http.StatusConflict, nil
		}},
		{"workspace token deactivates (removal)", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			tokID, tok := d.th.mint(d.w)
			v := d.wsTokenUser(tok, "Vic")
			return v, func() int {
				return d.th.scim(d.h, tok, http.MethodPatch, "/scim/v2/Users/"+v.ID, activePatch(false)).Code
			}, http.StatusOK, []wantAudit{{remove, "approver", "", "scim_token:" + tokID}}
		}},
		{"workspace token reactivates (default role)", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			tokID, tok := d.th.mint(d.w)
			v := d.wsTokenUser(tok, "Vic")
			if code := d.th.scim(d.h, tok, http.MethodPatch, "/scim/v2/Users/"+v.ID, activePatch(false)).Code; code != http.StatusOK {
				d.t.Fatalf("deactivate = %d", code)
			}
			return v, func() int {
				return d.th.scim(d.h, tok, http.MethodPatch, "/scim/v2/Users/"+v.ID, activePatch(true)).Code
			}, http.StatusOK, []wantAudit{{change, "", "approver", "scim_token:" + tokID}}
		}},
		{"workspace token DELETE (removal)", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			tokID, tok := d.th.mint(d.w)
			v := d.wsTokenUser(tok, "Vic")
			return v, func() int { return d.th.scim(d.h, tok, http.MethodDelete, "/scim/v2/Users/"+v.ID, "").Code }, http.StatusNoContent, []wantAudit{{remove, "approver", "", "scim_token:" + tokID}}
		}},
		{"instance token adds to the workspace group", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			v := d.scimUser("Vic")
			return v, func() int {
				return d.instance(http.MethodPatch, "/scim/v2/Groups/"+d.w.ws.ID, scimGroupPatch("add", v.ID))
			}, http.StatusOK, []wantAudit{{change, "", "approver", "scim_instance_token"}}
		}},
		{"instance token removes from the workspace group", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			v := d.scimUser("Vic", "approver")
			return v, func() int {
				return d.instance(http.MethodPatch, "/scim/v2/Groups/"+d.w.ws.ID, scimGroupPatch("remove", v.ID))
			}, http.StatusOK, []wantAudit{{remove, "approver", "", "scim_instance_token"}}
		}},
		{"instance disable removes the membership", func(d *d617) (identity.User, func() int, int, []wantAudit) {
			v := d.scimUser("Vic", "approver")
			return v, func() int { return d.patchActive(v, false) }, http.StatusOK, []wantAudit{{remove, "approver", "", "scim_instance_token"}}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newD617(t)
			target, act, wantCode, want := c.setup(d)
			base := len(d.memberAudits(target.ID))
			if code := act(); code != wantCode {
				t.Fatalf("code = %d, want %d", code, wantCode)
			}
			name := target.DisplayName
			if target.ID == d.owner().ID {
				name = ""
			}
			d.checkAudits(d.memberAudits(target.ID)[base:], want, name)
		})
	}
}

// A first grant through PUT and a workspace-token user add are role
// changes from no roles.
func TestMemberFirstGrantsAreAudited(t *testing.T) {
	const change = "workspace_member.roles_change"
	d := newD617(t)
	v := d.member("Vic", "approver")
	d.checkAudits(d.memberAudits(v.ID), []wantAudit{{change, "", "approver", "user:" + d.owner().ID}}, "Vic")
	tokID, tok := d.th.mint(d.w)
	u := d.wsTokenUser(tok, "Una")
	d.checkAudits(d.memberAudits(u.ID), []wantAudit{{change, "", "approver", "scim_token:" + tokID}}, "Una")
}

// wsTokenUser creates a user through a workspace SCIM token; the token
// grants the default role (approver).
func (d *d617) wsTokenUser(tok, name string) identity.User {
	d.t.Helper()
	rec := d.th.scim(d.h, tok, http.MethodPost, "/scim/v2/Users", scimUserJSON(d.th.uniq("ws617"), d.th.uniq("ws617-ext"), name))
	if rec.Code != http.StatusCreated {
		d.t.Fatalf("workspace token post: %d %s", rec.Code, rec.Body.String())
	}
	return identity.User{ID: decodeScimUser(d.t, rec).ID, DisplayName: name}
}

// No role audit row (or no-enabled-admin row) holds a token, a bearer
// value or an email, every row names an actor, and details carry only
// role keys, UUIDs, display names and the actor kind.
func TestMemberAuditRowsHoldNoTokenOrEmail(t *testing.T) {
	d := newD617(t)
	_, tok := d.th.mint(d.w)
	mail := d.member("vic@example.com", "approver")
	d.setRoles(d.owner(), mail, "viewer")
	d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/members/"+mail.ID, "")
	u := d.wsTokenUser(tok, "una@example.com")
	d.th.scim(d.h, tok, http.MethodPatch, "/scim/v2/Users/"+u.ID, activePatch(false))
	d.th.scim(d.h, tok, http.MethodPatch, "/scim/v2/Users/"+u.ID, activePatch(true))
	d.th.scim(d.h, tok, http.MethodDelete, "/scim/v2/Users/"+u.ID, "")
	i := d.scimUser("ivy@example.com")
	d.instance(http.MethodPatch, "/scim/v2/Groups/"+d.w.ws.ID, scimGroupPatch("add", i.ID))
	a := d.scimUser("Ada", "admin")
	d.dropOwner()
	d.patchActive(a, false)
	rows, err := d.th.admin.Query(d.th.ctx, `
		SELECT action, COALESCE(actor_id::text, ''), host_context_redacted::text, details_redacted::text, details_redacted
		  FROM audit_events
		 WHERE workspace_id = $1::uuid AND (resource_type = 'workspace_member' OR action = 'workspace.no_enabled_admin')`, d.w.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	allowed := map[string]bool{"userId": true, "displayName": true, "rolesBefore": true, "rolesAfter": true, "actorDisplayName": true, "tokenId": true, "via": true}
	n := 0
	for rows.Next() {
		var action, actor, host, raw string
		var details map[string]any
		if err := rows.Scan(&action, &actor, &host, &raw, &details); err != nil {
			t.Fatal(err)
		}
		n++
		all := strings.ToLower(host + raw)
		for _, bad := range []string{tok, "ffscim_", "bearer", "@", "example.com"} {
			if strings.Contains(all, strings.ToLower(bad)) {
				t.Fatalf("%s row holds %q: %s %s", action, bad, host, raw)
			}
		}
		for k := range details {
			if !allowed[k] {
				t.Fatalf("%s row has unexpected detail %q: %s", action, k, raw)
			}
		}
		if actor == "" && details["via"] == nil {
			t.Fatalf("%s row has no actor: %s", action, raw)
		}
	}
	if n < 8 {
		t.Fatalf("only %d audit rows", n)
	}
}
