package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5/pgxpool"
)

// targetsHarness drives targeted approval gates over Postgres through the
// claim endpoint (the compose worker park path).
type targetsHarness struct {
	t      *testing.T
	ctx    context.Context
	h      http.Handler
	admin  *pgxpool.Pool
	app    *pgxpool.Pool
	owner  identity.User
	tenant identity.Tenant
	ws     identity.Workspace
	n      int64
	seq    int
}

func newTargetsHarness(t *testing.T) *targetsHarness {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	adminPool, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(adminPool.Close)
	n := time.Now().UnixNano()
	owner := identity.User{Issuer: "https://idp.example", ExternalSubject: fmt.Sprintf("tgt-owner-%d", n), DisplayName: "Owner"}
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:          identity.NewPostgres(pool),
		Scoped:         isolation.NewPostgres(pool),
		Workflows:      wfstore.NewPostgres(pool),
		Ops:            opsconfig.NewPostgres(pool),
		Approvals:      approval.NewPostgres(pool),
		PlatformAdmins: []authz.PrincipalRef{{Issuer: owner.Issuer, Subject: owner.ExternalSubject}},
	}))
	th := &targetsHarness{t: t, ctx: ctx, h: h, admin: adminPool, app: pool, owner: owner, n: n}
	th.tenant, th.ws, th.owner = th.newWorkspace(fmt.Sprintf("tg%d", n%1_000_000_000_000), "tgwb")
	return th
}

func (th *targetsHarness) newWorkspace(slug, workbench string) (identity.Tenant, identity.Workspace, identity.User) {
	th.t.Helper()
	rec := httptest.NewRecorder()
	th.h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"`+slug+`","name":"Targets"}`, th.owner))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	var tenant identity.Tenant
	_ = json.Unmarshal(rec.Body.Bytes(), &tenant)
	rec = httptest.NewRecorder()
	th.h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"`+slug+`","workbench_key":"`+workbench+`","name":"WB"}`, th.owner))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	var ws identity.Workspace
	_ = json.Unmarshal(rec.Body.Bytes(), &ws)
	var id string
	if err := th.admin.QueryRow(th.ctx, `SELECT id::text FROM users WHERE external_subject = $1`, th.owner.ExternalSubject).Scan(&id); err != nil {
		th.t.Fatal(err)
	}
	owner := th.owner
	owner.ID = id
	return tenant, ws, owner
}

func (th *targetsHarness) do(user identity.User, method, path, body string) *httptest.ResponseRecorder {
	th.t.Helper()
	return th.doIn(user, th.tenant, th.ws, method, path, body)
}

func (th *targetsHarness) doIn(user identity.User, tenant identity.Tenant, ws identity.Workspace, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	if body == "" {
		th.h.ServeHTTP(rec, workspaceRequest(method, path, nil, user, tenant, ws))
	} else {
		th.h.ServeHTTP(rec, workspaceJSON(method, path, []byte(body), user, tenant, ws))
	}
	return rec
}

func (th *targetsHarness) member(subject, role string) identity.User {
	th.t.Helper()
	m := putMember(th.t, th.h, th.owner, th.tenant, th.ws, fmt.Sprintf(`{"issuer":"https://idp.example","external_subject":"%s-%d","display_name":"%s","role_keys":["%s"]}`, subject, th.n, subject, role))
	return m.User
}

func (th *targetsHarness) group(name string) string {
	th.t.Helper()
	return th.groupIn(th.tenant, th.ws, name)
}

func (th *targetsHarness) groupIn(tenant identity.Tenant, ws identity.Workspace, name string) string {
	th.t.Helper()
	rec := th.doIn(th.owner, tenant, ws, http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"`+name+`"}`)
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("group: %d %s", rec.Code, rec.Body.String())
	}
	var g identity.Group
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	return g.ID
}

func (th *targetsHarness) addToGroup(groupID, userID string) {
	th.t.Helper()
	if rec := th.do(th.owner, http.MethodPost, "/api/v1/workspace/groups/"+groupID+"/members", `{"userId":"`+userID+`"}`); rec.Code != http.StatusNoContent {
		th.t.Fatalf("add member: %d %s", rec.Code, rec.Body.String())
	}
}

func (th *targetsHarness) removeFromGroup(groupID, userID string) {
	th.t.Helper()
	if rec := th.do(th.owner, http.MethodDelete, "/api/v1/workspace/groups/"+groupID+"/members/"+userID, ""); rec.Code != http.StatusNoContent {
		th.t.Fatalf("remove member: %d %s", rec.Code, rec.Body.String())
	}
}

func targetedGateYAML(name string, users, groups []string) string {
	q := func(ids []string) string {
		if len(ids) == 0 {
			return "[]"
		}
		return `["` + strings.Join(ids, `", "`) + `"]`
	}
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ` + name + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Approve
      with:
        approverRole: approver
        expiresIn: PT15M
        approvers:
          users: ` + q(users) + `
          groups: ` + q(groups) + `
  edges: []
`
}

// publishTargeted creates and publishes a targeted gate workflow and
// returns the raw publish response.
func (th *targetsHarness) publishRaw(users, groups []string) (*httptest.ResponseRecorder, string) {
	th.t.Helper()
	th.seq++
	wf := createWorkflow(th.t, th.h, th.owner, th.tenant, th.ws, targetedGateYAML(fmt.Sprintf("targets-%d", th.seq), users, groups))
	body, _ := json.Marshal(map[string]any{"revision": wf.Draft.Revision, "note": "targets"})
	return th.do(th.owner, http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", string(body)), wf.Workflow.ID
}

// park publishes, starts as the owner, and claims once. It returns the
// execution id.
func (th *targetsHarness) park(users, groups []string) string {
	th.t.Helper()
	rec, wfID := th.publishRaw(users, groups)
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	var pub publishResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	exec := startExecution(th.t, th.h, th.owner, th.tenant, th.ws, wfID, pub.Version.ID)
	th.do(th.owner, http.MethodPost, "/api/v1/jobs/claim", fmt.Sprintf(`{"workerId":"targets-%d","leaseSeconds":5}`, th.seq))
	return exec.ID
}

func (th *targetsHarness) pendingFor(executionID string, as identity.User) approval.Record {
	th.t.Helper()
	rec := th.do(as, http.MethodGet, "/api/v1/approvals?status=pending&executionId="+executionID, "")
	if rec.Code != http.StatusOK {
		th.t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[approval.Record]
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Items) != 1 {
		th.t.Fatalf("pending for %s = %s", executionID, rec.Body.String())
	}
	return listed.Items[0]
}

func (th *targetsHarness) get(id string, as identity.User) approval.Record {
	th.t.Helper()
	rec := th.do(as, http.MethodGet, "/api/v1/approvals/"+id, "")
	if rec.Code != http.StatusOK {
		th.t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	var out approval.Record
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

func (th *targetsHarness) awaitingMe(as identity.User) map[string]bool {
	th.t.Helper()
	rec := th.do(as, http.MethodGet, "/api/v1/approvals?awaiting=me", "")
	if rec.Code != http.StatusOK {
		th.t.Fatalf("awaiting=me: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[approval.Record]
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	out := map[string]bool{}
	for _, r := range listed.Items {
		out[r.ID] = true
	}
	return out
}

func (th *targetsHarness) decide(id string, as identity.User) *httptest.ResponseRecorder {
	return th.do(as, http.MethodPost, "/api/v1/approvals/"+id+"/decide", `{"decision":"approved"}`)
}

func (th *targetsHarness) lastVia(id string) string {
	th.t.Helper()
	var via string
	err := th.admin.QueryRow(th.ctx, `
		SELECT coalesce(details->>'via','') FROM approval_events
		 WHERE approval_id = $1::uuid AND event_type = 'approved'
		 ORDER BY occurred_at DESC LIMIT 1`, id).Scan(&via)
	if err != nil {
		th.t.Fatalf("approved event: %v", err)
	}
	return via
}

func (th *targetsHarness) overrideAudits(id string) int {
	th.t.Helper()
	var n int
	if err := th.admin.QueryRow(th.ctx, `SELECT count(*) FROM audit_events WHERE action = $1 AND resource_id = $2`, approval.AuditDecidedByAdminOverride, id).Scan(&n); err != nil {
		th.t.Fatal(err)
	}
	return n
}

func TestApprovalTargetsAgainstPostgres(t *testing.T) {
	th := newTargetsHarness(t)
	parent := t
	run := func(name string, fn func(t *testing.T)) {
		parent.Run(name, func(t *testing.T) {
			th.t = t
			defer func() { th.t = parent }()
			fn(t)
		})
	}
	empty := th.group("Empty approvers")

	// Case 1: the only admin is the requester and nobody else can decide.
	run("only admin is requester fails no_eligible_decider", func(t *testing.T) {
		execID := th.park(nil, []string{empty})
		rec := th.do(th.owner, http.MethodGet, "/api/v1/executions/"+execID, "")
		var got struct {
			Status              string         `json:"status"`
			StatusReason        string         `json:"statusReason"`
			StatusReasonDetails map[string]any `json:"statusReasonDetails"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		if got.Status != "failed" || got.StatusReason != "requirement_unresolvable" || got.StatusReasonDetails["cause"] != "no_eligible_decider" {
			t.Fatalf("execution = %s", rec.Body.String())
		}
		var n int
		if err := th.admin.QueryRow(th.ctx, `SELECT count(*) FROM approvals WHERE execution_id = $1::uuid AND status = 'pending'`, execID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("pending rows = %d %v", n, err)
		}
	})

	admin2 := th.member("tgt-admin2", "admin")
	alice := th.member("tgt-alice", "approver")
	bob := th.member("tgt-bob", "approver")

	// Cases 2 and 9: a second admin lets the gate park; the decision is an
	// override, and the admin is actionable but not in awaiting=me.
	run("second admin parks and decides by override", func(t *testing.T) {
		execID := th.park(nil, []string{empty})
		row := th.pendingFor(execID, admin2)
		if row.Approvers == nil || len(row.Approvers.Groups) != 1 || row.Approvers.Groups[0].ID != empty || row.Approvers.Groups[0].DisplayName != "Empty approvers" {
			t.Fatalf("approvers = %+v", row.Approvers)
		}
		if c := row.Capabilities; c == nil || !c.Decide.Allowed || c.Decide.Via != approval.ViaAdminOverride {
			t.Fatalf("admin capabilities = %+v", row.Capabilities)
		}
		if th.awaitingMe(admin2)[row.ID] {
			t.Fatal("non-targeted admin must not see the gate in awaiting=me")
		}
		if c := th.get(row.ID, th.owner).Capabilities; c == nil || c.Decide.Allowed || c.Decide.Code != approval.CapSelfApproval {
			t.Fatalf("requester capabilities = %+v", c)
		}
		if c := th.get(row.ID, bob).Capabilities; c == nil || c.Decide.Allowed || c.Decide.Code != approval.CapApproverNotTargeted {
			t.Fatalf("bob capabilities = %+v", c)
		}
		assertProblem(t, th.decide(row.ID, bob), http.StatusForbidden, CodeApproverNotTargeted, "")
		assertProblem(t, th.decide(row.ID, th.owner), http.StatusForbidden, CodeForbidden, "")
		if rec := th.decide(row.ID, admin2); rec.Code != http.StatusOK {
			t.Fatalf("override decide: %d %s", rec.Code, rec.Body.String())
		}
		if via := th.lastVia(row.ID); via != approval.ViaAdminOverride {
			t.Fatalf("via = %q", via)
		}
		if n := th.overrideAudits(row.ID); n != 1 {
			t.Fatalf("override audits = %d", n)
		}
	})

	// Cases 7, 4, and 3: added mid-wait can decide, removed gets 403,
	// re-added approves through the group.
	run("live group membership decides", func(t *testing.T) {
		g := th.group("Live approvers")
		execID := th.park(nil, []string{g})
		row := th.pendingFor(execID, admin2)
		if th.awaitingMe(alice)[row.ID] {
			t.Fatal("alice is not in the group yet")
		}
		th.addToGroup(g, alice.ID)
		if !th.awaitingMe(alice)[row.ID] {
			t.Fatal("alice added mid-wait must see the gate in awaiting=me")
		}
		if c := th.get(row.ID, alice).Capabilities; c == nil || !c.Decide.Allowed || c.Decide.Via != approval.ViaTarget {
			t.Fatalf("alice capabilities = %+v", c)
		}
		th.removeFromGroup(g, alice.ID)
		assertProblem(t, th.decide(row.ID, alice), http.StatusForbidden, CodeApproverNotTargeted, "")
		th.addToGroup(g, alice.ID)
		if rec := th.decide(row.ID, alice); rec.Code != http.StatusOK {
			t.Fatalf("group decide: %d %s", rec.Code, rec.Body.String())
		}
		if via := th.lastVia(row.ID); via != approval.ViaTarget {
			t.Fatalf("via = %q", via)
		}
		if n := th.overrideAudits(row.ID); n != 0 {
			t.Fatalf("override audits = %d", n)
		}
	})

	run("named user decides", func(t *testing.T) {
		execID := th.park([]string{bob.ID}, nil)
		row := th.pendingFor(execID, bob)
		if row.Approvers == nil || len(row.Approvers.Users) != 1 || row.Approvers.Users[0].ID != bob.ID {
			t.Fatalf("approvers = %+v", row.Approvers)
		}
		assertProblem(t, th.decide(row.ID, alice), http.StatusForbidden, CodeApproverNotTargeted, "")
		if rec := th.decide(row.ID, bob); rec.Code != http.StatusOK {
			t.Fatalf("user decide: %d %s", rec.Code, rec.Body.String())
		}
	})

	// Case 5: a group deleted mid-wait leaves nobody targeted; members get
	// 403 and an admin override still works.
	run("group deleted mid-wait", func(t *testing.T) {
		g := th.group("Doomed approvers")
		th.addToGroup(g, alice.ID)
		execID := th.park(nil, []string{g})
		row := th.pendingFor(execID, alice)
		if rec := th.do(th.owner, http.MethodDelete, "/api/v1/workspace/groups/"+g, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("delete group: %d %s", rec.Code, rec.Body.String())
		}
		assertProblem(t, th.decide(row.ID, alice), http.StatusForbidden, CodeApproverNotTargeted, "")
		if rec := th.decide(row.ID, admin2); rec.Code != http.StatusOK {
			t.Fatalf("override after delete: %d %s", rec.Code, rec.Body.String())
		}
		if via := th.lastVia(row.ID); via != approval.ViaAdminOverride {
			t.Fatalf("via = %q", via)
		}
	})

	// Case 6: removing a workspace member while that member decides never
	// deadlocks. Decide locks the approval row, then reads membership FOR
	// SHARE; removal never touches the approval row.
	run("remove member and decide do not deadlock", func(t *testing.T) {
		g := th.group("Race approvers")
		for i := 0; i < 6; i++ {
			racer := th.member(fmt.Sprintf("tgt-racer-%d", i), "approver")
			th.addToGroup(g, racer.ID)
			execID := th.park(nil, []string{g})
			row := th.pendingFor(execID, racer)
			var wg sync.WaitGroup
			var decideCode, removeCode int
			start := make(chan struct{})
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				decideCode = th.decide(row.ID, racer).Code
			}()
			go func() {
				defer wg.Done()
				<-start
				removeCode = th.do(th.owner, http.MethodDelete, "/api/v1/workspace/members/"+racer.ID, "").Code
			}()
			done := make(chan struct{})
			close(start)
			go func() { wg.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(20 * time.Second):
				t.Fatal("remove member and decide did not finish")
			}
			if decideCode != http.StatusOK && decideCode != http.StatusForbidden && decideCode != http.StatusUnauthorized {
				t.Fatalf("decide = %d", decideCode)
			}
			if removeCode >= 500 {
				t.Fatalf("remove = %d", removeCode)
			}
		}
	})

	// The snapshot tables are FORCE RLS: the app role sees a row's
	// snapshot only inside its own workspace.
	run("snapshot rows are workspace isolated", func(t *testing.T) {
		g := th.group("Isolated approvers")
		execID := th.park([]string{bob.ID}, []string{g})
		row := th.pendingFor(execID, bob)
		count := func(workspaceID string) int {
			tx, err := postgres.BeginScoped(th.ctx, th.app, workspaceID)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(th.ctx)
			var n int
			if err := tx.QueryRow(th.ctx, `
				SELECT (SELECT count(*) FROM approval_approver_users WHERE approval_id = $1::uuid)
				     + (SELECT count(*) FROM approval_approver_groups WHERE approval_id = $1::uuid)`, row.ID).Scan(&n); err != nil {
				t.Fatal(err)
			}
			return n
		}
		if n := count(th.ws.ID); n != 2 {
			t.Fatalf("own workspace sees %d snapshot rows", n)
		}
		if n := count("00000000-0000-4000-8000-000000000001"); n != 0 {
			t.Fatalf("other workspace sees %d snapshot rows", n)
		}
	})

	// Case 8: another tenant's group id gets the same 400 as a random UUID.
	run("cross-tenant group matches random uuid", func(t *testing.T) {
		otherTenant, otherWS, _ := th.newWorkspace(fmt.Sprintf("tgx%d", th.n%1_000_000_000_000), "tgxwb")
		foreign := th.groupIn(otherTenant, otherWS, "Foreign approvers")
		random := "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b"
		problemFor := func(id string) Problem {
			rec, _ := th.publishRaw(nil, []string{id})
			p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "")
			if len(p.Errors) != 1 || p.Errors[0].Code != "approver-group-not-found" || p.Errors[0].Path != "spec.nodes[0].with.approvers.groups[0]" {
				t.Fatalf("errors = %+v", p.Errors)
			}
			return p
		}
		a, b := problemFor(foreign), problemFor(random)
		if a.Detail != b.Detail || a.Errors[0].Message != b.Errors[0].Message {
			t.Fatalf("cross-tenant %+v differs from random %+v", a, b)
		}
	})

	run("approver candidates", func(t *testing.T) {
		rec := th.do(th.owner, http.MethodGet, "/api/v1/approvals/approver-candidates?role=approver", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("candidates: %d %s", rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		if !strings.Contains(body, bob.ID) || !strings.Contains(body, empty) || strings.Contains(body, "external_subject") || strings.Contains(body, "@") {
			t.Fatalf("candidates = %s", body)
		}
		p := assertProblem(t, th.do(th.owner, http.MethodGet, "/api/v1/approvals/approver-candidates?role=nope", ""), http.StatusBadRequest, CodeInvalidRequest, "")
		if len(p.Errors) != 1 || p.Errors[0].Path != "role" {
			t.Fatalf("errors = %+v", p.Errors)
		}
		assertProblem(t, th.do(th.owner, http.MethodGet, "/api/v1/approvals?awaiting=you", ""), http.StatusBadRequest, CodeInvalidRequest, "")
	})

	// Boot resync applies the park rule: a targeted gate whose approvers
	// and other admins have all gone is canceled and the run fails with
	// no_eligible_decider. Runs last because it demotes the second admin.
	run("boot resync cancels without an eligible decider", func(t *testing.T) {
		g := th.group("Resync approvers")
		th.addToGroup(g, alice.ID)
		execID := th.park(nil, []string{g})
		row := th.pendingFor(execID, alice)
		th.removeFromGroup(g, alice.ID)
		putMember(t, th.h, th.owner, th.tenant, th.ws, fmt.Sprintf(`{"issuer":"https://idp.example","external_subject":"tgt-admin2-%d","role_keys":["approver"]}`, th.n))
		approval.ResyncOpenApprovals(th.ctx, th.app, wfstore.NewPostgres(th.app), opsconfig.NewPostgres(th.app), nil)
		got := th.get(row.ID, th.owner)
		if got.Status != approval.StatusCanceled || got.CloseReason != approval.ReasonRequirementUnresolvable || got.CloseReasonDetails["cause"] != approval.CauseNoEligibleDecider {
			t.Fatalf("approval = %s %s %v", got.Status, got.CloseReason, got.CloseReasonDetails)
		}
		rec := th.do(th.owner, http.MethodGet, "/api/v1/executions/"+execID, "")
		var exec struct {
			Status              string         `json:"status"`
			StatusReasonDetails map[string]any `json:"statusReasonDetails"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &exec)
		if exec.Status != "failed" || exec.StatusReasonDetails["cause"] != "no_eligible_decider" {
			t.Fatalf("execution = %s", rec.Body.String())
		}
	})
}
