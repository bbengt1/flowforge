package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
)

// Test 7 (#620): the in-memory stores match Postgres for machine
// principals: publish refuses naming one, the picker leaves it out, park
// skips it, it is never the admin fallback, and decide refuses it on
// every route with nothing written.
func TestMemoryMachinePrincipalsNeverApprove(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	do := func(as identity.User, method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		if body == "" {
			h.ServeHTTP(rec, workspaceRequest(method, path, nil, as, tenant, ws))
		} else {
			h.ServeHTTP(rec, workspaceJSON(method, path, []byte(body), as, tenant, ws))
		}
		return rec
	}
	put := func(issuer, subject, name string, roles ...string) identity.User {
		rk, _ := json.Marshal(roles)
		m := putMember(t, h, admin, tenant, ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":%q,"role_keys":%s}`, issuer, subject, name, rk))
		return identity.User{ID: m.User.ID, Issuer: issuer, ExternalSubject: subject, DisplayName: name}
	}
	group := func(name string, members ...identity.User) string {
		rec := do(admin, http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"`+name+`"}`)
		if rec.Code != http.StatusCreated {
			t.Fatalf("group: %d %s", rec.Code, rec.Body.String())
		}
		var g identity.Group
		_ = json.Unmarshal(rec.Body.Bytes(), &g)
		for _, m := range members {
			if rec := do(admin, http.MethodPost, "/api/v1/workspace/groups/"+g.ID+"/members", `{"userId":"`+m.ID+`"}`); rec.Code != http.StatusNoContent {
				t.Fatalf("add member: %d %s", rec.Code, rec.Body.String())
			}
		}
		return g.ID
	}
	seq := 0
	publish := func(users, groups []string) (*httptest.ResponseRecorder, string) {
		seq++
		wf := createWorkflow(t, h, admin, tenant, ws, gateYAML(fmt.Sprintf("mem-620-%d", seq), users, groups))
		body, _ := json.Marshal(map[string]any{"revision": wf.Draft.Revision, "note": "620"})
		return do(admin, http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", string(body)), wf.Workflow.ID
	}
	run := func(users, groups []string) (string, *approval.Record) {
		t.Helper()
		rec, wfID := publish(users, groups)
		if rec.Code != http.StatusCreated {
			t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
		}
		var pub publishResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &pub)
		exec := startExecution(t, h, admin, tenant, ws, wfID, pub.Version.ID)
		do(admin, http.MethodPost, "/api/v1/jobs/claim", fmt.Sprintf(`{"workerId":"mem-620-%d","leaseSeconds":5}`, seq))
		list := do(admin, http.MethodGet, "/api/v1/approvals?executionId="+exec.ID, "")
		var listed listResponse[approval.Record]
		_ = json.Unmarshal(list.Body.Bytes(), &listed)
		if len(listed.Items) == 0 {
			return exec.ID, nil
		}
		return exec.ID, &listed.Items[0]
	}

	bot := put(machine.Issuer, "mem-620-bot", "Bot", "approver", "admin")
	empty := group("Empty")

	t.Run("machine admin is not the override fallback", func(t *testing.T) {
		if _, row := run(nil, []string{empty}); row != nil {
			t.Fatalf("gate parked with only a machine admin beside the requester: %+v", row)
		}
	})
	t.Run("machine-only group never parks", func(t *testing.T) {
		g := group("Bots", bot)
		if _, row := run(nil, []string{g}); row != nil {
			t.Fatalf("gate parked with only a machine group member: %+v", row)
		}
	})
	t.Run("last-admin guard ignores the machine admin", func(t *testing.T) {
		rec := do(admin, http.MethodDelete, "/api/v1/workspace/members/"+admin.ID, "")
		if rec.Code != http.StatusConflict {
			t.Fatalf("remove last human admin = %d %s", rec.Code, rec.Body.String())
		}
	})

	human := put("https://idp.example", "mem-620-h", "Hana", "approver")
	mixed := group("Mixed", bot, human)

	t.Run("publish naming a machine", func(t *testing.T) {
		rec, _ := publish([]string{bot.ID}, nil)
		p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "")
		if len(p.Errors) != 1 || p.Errors[0].Code != "approver-not-person" || p.Errors[0].Message != machineApproverMessage {
			t.Fatalf("errors = %+v", p.Errors)
		}
	})
	t.Run("candidates exclude machines", func(t *testing.T) {
		body := do(admin, http.MethodGet, "/api/v1/approvals/approver-candidates?role=approver", "").Body.String()
		if strings.Contains(body, bot.ID) || !strings.Contains(body, human.ID) || !strings.Contains(body, mixed) {
			t.Fatalf("candidates = %s", body)
		}
	})
	t.Run("decide refused on every route", func(t *testing.T) {
		for name, gate := range map[string][2][]string{
			"group member":   {nil, {mixed}},
			"admin override": {{human.ID}, nil},
			"untargeted":     {nil, nil},
		} {
			_, row := run(gate[0], gate[1])
			if row == nil || row.Status != approval.StatusPending {
				t.Fatalf("%s: gate did not park", name)
			}
			got := do(bot, http.MethodGet, "/api/v1/approvals/"+row.ID, "")
			var view approval.Record
			_ = json.Unmarshal(got.Body.Bytes(), &view)
			if view.Capabilities == nil || view.Capabilities.Decide.Allowed {
				t.Fatalf("%s: machine capabilities = %s", name, got.Body.String())
			}
			assertProblem(t, do(bot, http.MethodPost, "/api/v1/approvals/"+row.ID+"/decide", `{"decision":"approved"}`), http.StatusForbidden, CodeForbidden, "")
			after := do(admin, http.MethodGet, "/api/v1/approvals/"+row.ID, "")
			_ = json.Unmarshal(after.Body.Bytes(), &view)
			if view.Status != approval.StatusPending || view.DecidedBy != "" {
				t.Fatalf("%s: after machine decide = %s", name, after.Body.String())
			}
		}
	})
}
