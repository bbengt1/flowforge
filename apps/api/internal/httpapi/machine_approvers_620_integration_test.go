package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// #620: a machine principal (users.issuer = machine.Issuer) is never a
// person who can approve. Publish refuses naming one, park and every
// re-check skip it, it never counts as an enabled admin, the picker
// leaves it out, and decide refuses it on every route. Real Postgres,
// the workspaces-mode server, -p 1.

const machineApproverMessage = "This approver is a machine account. Only a person can approve this step."

// publish620 publishes a targeted gate as the owner and returns the raw
// response and the workflow id.
func (d *d617) publish620(users, groups []string) (int, string, string) {
	d.t.Helper()
	d.th.seq++
	wf := createWorkflow(d.t, d.h, d.owner(), d.w.tenant, d.w.ws, targetedGateYAML(fmt.Sprintf("m620-gate-%d-%d", d.th.n, d.th.seq), users, groups))
	body, _ := json.Marshal(map[string]any{"revision": wf.Draft.Revision, "note": "620"})
	rec := d.do(d.owner(), http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", string(body))
	return rec.Code, rec.Body.String(), wf.Workflow.ID
}

// gateYAML is targetedGateYAML, or a plain role gate (no approvers
// block) when users and groups are both empty.
func gateYAML(name string, users, groups []string) string {
	if len(users) == 0 && len(groups) == 0 {
		return strings.Replace(targetedGateYAML(name, nil, nil), "        approvers:\n          users: []\n          groups: []\n", "", 1)
	}
	return targetedGateYAML(name, users, groups)
}

// parkUntargeted publishes a role-only gate, starts it as requester and
// claims it; it must start waiting.
func (d *d617) parkUntargeted(requester identity.User) string {
	d.t.Helper()
	d.th.seq++
	wf := createWorkflow(d.t, d.h, d.owner(), d.w.tenant, d.w.ws, gateYAML(fmt.Sprintf("m620-plain-%d-%d", d.th.n, d.th.seq), nil, nil))
	body, _ := json.Marshal(map[string]any{"revision": wf.Draft.Revision, "note": "620"})
	rec := d.do(d.owner(), http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", string(body))
	if rec.Code != http.StatusCreated {
		d.t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	var pub publishResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	exec := startExecution(d.t, d.h, requester, d.w.tenant, d.w.ws, wf.Workflow.ID, pub.Version.ID).ID
	if code := d.claim(requester); code != http.StatusOK {
		d.t.Fatalf("claim: %d", code)
	}
	if got := d.th.gate(exec); got != "pending" {
		d.t.Fatalf("gate did not park: %q", got)
	}
	return exec
}

// legacyMachineSnapshot rewrites a parked gate's user snapshot so it
// names m, the state a gate parked before #620 could be in. Admin pool;
// no re-check runs.
func (d *d617) legacyMachineSnapshot(executionID string, m identity.User) string {
	d.t.Helper()
	id := d.approvalID(executionID)
	d.th.scalar(`WITH del AS (DELETE FROM approval_approver_users WHERE approval_id = $1::uuid RETURNING 1),
	                  ins AS (INSERT INTO approval_approver_users (workspace_id, approval_id, user_id)
	                          SELECT workspace_id, id, $2::uuid FROM approvals WHERE id = $1::uuid RETURNING 1)
	             SELECT ((SELECT count(*) FROM del) + (SELECT count(*) FROM ins))::text`, id, m.ID)
	return id
}

func (d *d617) decisionEvents(approvalID string) string {
	return d.th.scalar(`SELECT count(*)::text FROM approval_events WHERE approval_id = $1::uuid AND event_type IN ('approved','rejected','corrected')`, approvalID)
}

func (d *d617) getApproval(as identity.User, id string) approval.Record {
	d.t.Helper()
	rec := d.do(as, http.MethodGet, "/api/v1/approvals/"+id, "")
	if rec.Code != http.StatusOK {
		d.t.Fatalf("get approval: %d %s", rec.Code, rec.Body.String())
	}
	var out approval.Record
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

func (d *d617) listIDs(as identity.User, query string) map[string]bool {
	d.t.Helper()
	rec := d.do(as, http.MethodGet, "/api/v1/approvals?"+query, "")
	if rec.Code != http.StatusOK {
		d.t.Fatalf("list %s: %d %s", query, rec.Code, rec.Body.String())
	}
	var listed listResponse[approval.Record]
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	out := map[string]bool{}
	for _, r := range listed.Items {
		out[r.ID] = true
	}
	return out
}

// Test 1: publish naming a machine is 400 approver-not-person, checked
// after not-member; a group containing a machine still publishes.
func TestMachineApproverPublishRefused(t *testing.T) {
	d := newD617(t)
	m, _ := d.machineApprover("Bot")
	h := d.member("H", "approver")
	g := d.group("Mixed", m, h)

	code, body, _ := d.publish620(ids(h, m), nil)
	if code != http.StatusBadRequest {
		t.Fatalf("publish naming a machine = %d %s", code, body)
	}
	var p Problem
	_ = json.Unmarshal([]byte(body), &p)
	if p.Code != CodeInvalidWorkflow || len(p.Errors) != 1 {
		t.Fatalf("problem = %+v", p)
	}
	if e := p.Errors[0]; e.Code != "approver-not-person" || e.Path != "spec.nodes[0].with.approvers.users[1]" || e.Message != machineApproverMessage {
		t.Fatalf("error = %+v", e)
	}

	// A non-member still reads approver-not-member (checked first).
	stranger := "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b"
	code, body, _ = d.publish620([]string{stranger}, nil)
	_ = json.Unmarshal([]byte(body), &p)
	if code != http.StatusBadRequest || len(p.Errors) != 1 || p.Errors[0].Code != "approver-not-member" {
		t.Fatalf("non-member publish = %d %s", code, body)
	}

	if code, body, _ := d.publish620(nil, []string{g}); code != http.StatusCreated {
		t.Fatalf("publish naming a group with a machine member = %d %s", code, body)
	}
}

// Test 2: a machine group member is skipped at park. A group whose only
// member is a machine never parks; with a person beside it, the gate
// parks and the person is the decider.
func TestMachineGroupMemberSkippedAtPark(t *testing.T) {
	t.Run("machine is the only member", func(t *testing.T) {
		d := newD617(t)
		m, _ := d.machineApprover("Bot")
		g := d.group("Bots", m)
		exec := d.prepare(d.owner(), nil, []string{g})
		if code := d.claim(d.owner()); code != http.StatusOK && code != http.StatusForbidden {
			t.Fatalf("claim = %d", code)
		}
		d.assertNeverWaiting(d.owner(), exec)
	})
	t.Run("person beside the machine", func(t *testing.T) {
		d := newD617(t)
		m, _ := d.machineApprover("Bot")
		h := d.member("H", "approver")
		g := d.group("Mixed", m, h)
		exec := d.park(d.owner(), nil, []string{g})
		id := d.approvalID(exec)
		if c := d.getApproval(h, id).Capabilities; c == nil || !c.Decide.Allowed || c.Decide.Via != approval.ViaTarget {
			t.Fatalf("person capabilities = %+v", c)
		}
	})
}

// Test 3 and Terry's #625 check: a machine admin is not an enabled admin.
// It is not the override fallback, it does not keep the last-admin
// guard satisfied, and disabling the last human admin beside it writes
// workspace.no_enabled_admin.
func TestMachineAdminIsNotAnEnabledAdmin(t *testing.T) {
	t.Run("not the override fallback at park", func(t *testing.T) {
		d := newD617(t)
		m, _ := d.machineApprover("Bot")
		d.grant(m, "admin")
		empty := d.group("Empty")
		exec := d.prepare(d.owner(), nil, []string{empty})
		if code := d.claim(d.owner()); code != http.StatusOK && code != http.StatusForbidden {
			t.Fatalf("claim = %d", code)
		}
		d.assertNeverWaiting(d.owner(), exec)
	})
	t.Run("last-admin guard refuses removing the last human admin", func(t *testing.T) {
		d := newD617(t)
		m, _ := d.machineApprover("Bot")
		d.grant(m, "admin")
		if code := d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/members/"+d.owner().ID, "").Code; code != http.StatusConflict {
			t.Fatalf("remove last human admin = %d, want 409", code)
		}
		if code := d.setRoles(d.owner(), d.owner(), "operator").Code; code != http.StatusConflict {
			t.Fatalf("demote last human admin = %d, want 409", code)
		}
		// The machine admin itself can go: it was never an enabled admin.
		if code := d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/members/"+m.ID, "").Code; code != http.StatusNoContent {
			t.Fatalf("remove machine admin = %d, want 204", code)
		}
	})
	t.Run("disable the human admin: fallback re-check and no_enabled_admin", func(t *testing.T) {
		d := newD617(t)
		m, _ := d.machineApprover("Bot")
		d.grant(m, "admin")
		e, v := d.member("E", "operator"), d.scimUser("Vera Admin", "admin")
		empty := d.group("Empty")
		exec := d.park(e, nil, []string{empty}) // V (and the owner) are the fallback
		d.dropOwner()
		if code := d.patchActive(v, false); code != http.StatusOK {
			t.Fatalf("disable = %d", code)
		}
		d.assertClosed(e, exec)
		rows := d.noEnabledAdminRows()
		if len(rows) != 1 || rows[0].details["userId"] != v.ID {
			t.Fatalf("no_enabled_admin rows = %+v, want one for %s", rows, v.ID)
		}
	})
}

// Test 4: a machine holding both a targeting role and admin gets 403 on
// decide on every route (target, admin override, untargeted, a legacy
// snapshot naming it), nothing is written, and its capability is false.
func TestMachineDecideRefusedOnEveryRoute(t *testing.T) {
	d := newD617(t)
	m, _ := d.machineApprover("Bot")
	d.grant(m, "approver", "admin")
	h := d.member("H", "approver")
	mixed := d.group("Mixed", m, h)

	check := func(t *testing.T, exec string) string {
		t.Helper()
		id := d.approvalID(exec)
		if c := d.getApproval(m, id).Capabilities; c == nil || c.Decide.Allowed {
			t.Fatalf("machine capabilities = %+v, want denied", c)
		}
		if d.listIDs(m, "status=pending")[id] || d.listIDs(m, "awaiting=me")[id] {
			t.Fatal("gate is actionable for a machine")
		}
		assertProblem(t, d.do(m, http.MethodPost, "/api/v1/approvals/"+id+"/decide", `{"decision":"approved"}`), http.StatusForbidden, CodeForbidden, "")
		if got := d.th.gate(exec); got != "pending" {
			t.Fatalf("approval = %q after machine decide", got)
		}
		if n := d.decisionEvents(id); n != "0" {
			t.Fatalf("decision events = %s", n)
		}
		if n := d.th.scalar(`SELECT count(*)::text FROM audit_events WHERE action = $1 AND resource_id = $2::uuid`, approval.AuditDecidedByAdminOverride, id); n != "0" {
			t.Fatalf("override audits = %s", n)
		}
		d.assertWaiting(d.owner(), exec)
		return id
	}
	t.Run("live member of a snapshot group", func(t *testing.T) {
		check(t, d.park(d.owner(), nil, []string{mixed}))
	})
	t.Run("admin override route", func(t *testing.T) {
		check(t, d.park(d.owner(), ids(h), nil))
	})
	t.Run("untargeted gate", func(t *testing.T) {
		check(t, d.parkUntargeted(d.owner()))
	})
	t.Run("legacy snapshot naming the machine", func(t *testing.T) {
		exec := d.park(d.owner(), ids(h), nil)
		d.legacyMachineSnapshot(exec, m)
		check(t, exec)
	})
	t.Run("person still decides afterwards", func(t *testing.T) {
		exec := d.park(d.owner(), nil, []string{mixed})
		id := check(t, exec)
		if rec := d.do(h, http.MethodPost, "/api/v1/approvals/"+id+"/decide", `{"decision":"approved"}`); rec.Code != http.StatusOK {
			t.Fatalf("person decide = %d %s", rec.Code, rec.Body.String())
		}
	})
}

// Test 5: the builder picker leaves machines out; groups are unchanged.
func TestMachineApproverCandidatesExcluded(t *testing.T) {
	d := newD617(t)
	m, _ := d.machineApprover("Bot")
	d.grant(m, "approver", "admin")
	h := d.member("H", "approver")
	g := d.group("Mixed", m, h)
	rec := d.do(d.owner(), http.MethodGet, "/api/v1/approvals/approver-candidates?role=approver", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("candidates = %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, m.ID) || !strings.Contains(body, h.ID) || !strings.Contains(body, g) {
		t.Fatalf("candidates = %s", body)
	}
}

// Test 6: a waiting gate whose only decider is a machine settles through
// the no-eligible-decider path on the next re-check or resync. It is
// never approved.
func TestMachineOnlyDeciderSettlesNoEligibleDecider(t *testing.T) {
	t.Run("re-check after the person leaves the group", func(t *testing.T) {
		d := newD617(t)
		m, _ := d.machineApprover("Bot")
		h := d.member("H", "approver")
		g := d.group("Mixed", m, h)
		exec := d.park(d.owner(), nil, []string{g})
		if rec := d.do(d.owner(), http.MethodDelete, "/api/v1/workspace/groups/"+g+"/members/"+h.ID, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("remove member: %d %s", rec.Code, rec.Body.String())
		}
		d.assertClosed(d.owner(), exec)
	})
	t.Run("boot resync of a gate whose group now holds only a machine", func(t *testing.T) {
		d := newD617(t)
		m, _ := d.machineApprover("Bot")
		h := d.member("H", "approver")
		g := d.group("Swap", h)
		exec := d.park(d.owner(), nil, []string{g})
		// Change membership without the re-check (as if before #620).
		d.th.scalar(`WITH del AS (DELETE FROM workspace_group_members WHERE group_id = $1::uuid AND user_id = $2::uuid RETURNING 1),
		                  ins AS (INSERT INTO workspace_group_members (workspace_id, group_id, user_id)
		                          SELECT workspace_id, id, $3::uuid FROM workspace_groups WHERE id = $1::uuid RETURNING 1)
		             SELECT ((SELECT count(*) FROM del) + (SELECT count(*) FROM ins))::text`, g, h.ID, m.ID)
		d.assertWaiting(d.owner(), exec)
		approval.ResyncOpenApprovals(d.th.ctx, d.th.pool, wfstore.NewPostgres(d.th.pool), opsconfig.NewPostgres(d.th.pool), slog.New(slog.NewTextHandler(io.Discard, nil)))
		d.assertClosed(d.owner(), exec)
	})
	t.Run("legacy snapshot naming a machine closes on the machine's revoke", func(t *testing.T) {
		d := newD617(t)
		m, id := d.machineApprover("Bot")
		h := d.member("H", "approver")
		exec := d.park(d.owner(), ids(h), nil)
		d.legacyMachineSnapshot(exec, m)
		if code := d.do(d.owner(), http.MethodPost, "/api/v1/machine/principals/"+id+"/revoke", "").Code; code != http.StatusOK {
			t.Fatalf("revoke = %d", code)
		}
		d.assertClosed(d.owner(), exec)
	})
}
