package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SCIM_GROUPS_MODE over real Postgres. Two servers share one database:
// gm runs SCIM_GROUPS_MODE=groups and ws runs the default workspaces
// mode, so switching modes is the same as restarting with the other
// value. SCIM_DEFAULT_ROLE is approver so provisioned users can decide
// targeted gates.

type gmHarness struct {
	t      *testing.T
	ctx    context.Context
	gm, ws http.Handler
	admin  *pgxpool.Pool
	owner  identity.User
	n      int64
	seq    int
	logs   *lockedBuffer
}

func newGMHarness(t *testing.T) *gmHarness {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
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
	owner := identity.User{Issuer: scimIssuer, ExternalSubject: fmt.Sprintf("gm-owner-%d", n), DisplayName: "Owner"}
	logs := &lockedBuffer{}
	build := func(mode string) http.Handler {
		return NewWithDeps(withHTTPTestIdentity(Deps{
			Store:          identity.NewPostgres(pool),
			Scoped:         isolation.NewPostgres(pool),
			Sessions:       session.NewPostgres(pool),
			SCIMDir:        scim.NewPostgres(pool),
			ScimTokens:     scim.NewWorkspacePostgres(pool),
			Workflows:      wfstore.NewPostgres(pool),
			Ops:            opsconfig.NewPostgres(pool),
			Approvals:      approval.NewPostgres(pool),
			Log:            slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
			PlatformAdmins: []authz.PrincipalRef{{Issuer: owner.Issuer, Subject: owner.ExternalSubject}},
			SCIM: scim.Settings{
				BearerToken: scimTestToken,
				Issuer:      scimIssuer,
				DefaultRole: authz.RoleApprover,
				GroupsMode:  mode,
			},
		}))
	}
	return &gmHarness{t: t, ctx: ctx, gm: build(scim.GroupsModeGroups), ws: build(scim.GroupsModeWorkspaces), admin: adminPool, owner: owner, n: n, logs: logs}
}

func (th *gmHarness) uniq(prefix string) string {
	th.seq++
	return fmt.Sprintf("%s-%d-%d", prefix, th.n, th.seq)
}

func (th *gmHarness) workspace() scimWS {
	th.t.Helper()
	th.seq++
	slug := fmt.Sprintf("gm%d%d", th.n%1_000_000_000_000, th.seq)
	rec := httptest.NewRecorder()
	th.gm.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"`+slug+`","name":"GM"}`, th.owner))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	var tenant identity.Tenant
	_ = json.Unmarshal(rec.Body.Bytes(), &tenant)
	rec = httptest.NewRecorder()
	th.gm.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"`+slug+`","workbench_key":"gmwb","name":"GM WB"}`, th.owner))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	var ws identity.Workspace
	_ = json.Unmarshal(rec.Body.Bytes(), &ws)
	if th.owner.ID == "" {
		if err := th.admin.QueryRow(th.ctx, `SELECT id::text FROM users WHERE issuer = $1 AND external_subject = $2`, th.owner.Issuer, th.owner.ExternalSubject).Scan(&th.owner.ID); err != nil {
			th.t.Fatal(err)
		}
	}
	return scimWS{tenant: tenant, ws: ws}
}

func (th *gmHarness) local(h http.Handler, w scimWS, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	if body == "" {
		h.ServeHTTP(rec, workspaceRequest(method, path, nil, th.owner, w.tenant, w.ws))
	} else {
		h.ServeHTTP(rec, workspaceJSON(method, path, []byte(body), th.owner, w.tenant, w.ws))
	}
	return rec
}

func (th *gmHarness) mint(w scimWS) (id, token string) {
	th.t.Helper()
	rec := th.local(th.gm, w, http.MethodPost, "/api/v1/workspace/scim-tokens", `{"displayName":"IdP"}`)
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("mint: %d %s", rec.Code, rec.Body.String())
	}
	var body struct{ ID, Token string }
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return body.ID, body.Token
}

func (th *gmHarness) scim(h http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, scimRequest(method, path, body, token))
	return rec
}

func (th *gmHarness) user(token, name string) string {
	th.t.Helper()
	rec := th.scim(th.gm, token, http.MethodPost, "/scim/v2/Users", scimUserJSON(th.uniq(name), "", name))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("post user: %d %s", rec.Code, rec.Body.String())
	}
	return decodeScimUser(th.t, rec).ID
}

type gmGroup struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	ExternalID  string `json:"externalId"`
	Members     []struct {
		Value string `json:"value"`
	} `json:"members"`
}

func (g gmGroup) memberIDs() []string {
	out := []string{}
	for _, m := range g.Members {
		out = append(out, m.Value)
	}
	return out
}

func gmGroupJSON(name, ext string, members ...string) string {
	items := []map[string]string{}
	for _, m := range members {
		items = append(items, map[string]string{"value": m})
	}
	body := map[string]any{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:Group"}, "displayName": name, "members": items}
	if ext != "" {
		body["externalId"] = ext
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func gmPatch(ops ...string) string {
	return `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[` + strings.Join(ops, ",") + `]}`
}

func gmMembersOp(op string, ids ...string) string {
	items := []string{}
	for _, id := range ids {
		items = append(items, fmt.Sprintf(`{"value":%q}`, id))
	}
	return fmt.Sprintf(`{"op":%q,"path":"members","value":[%s]}`, op, strings.Join(items, ","))
}

func gmRenameOp(name string) string {
	return fmt.Sprintf(`{"op":"replace","path":"displayName","value":%q}`, name)
}

func decodeGM(t *testing.T, rec *httptest.ResponseRecorder) gmGroup {
	t.Helper()
	var g gmGroup
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil {
		t.Fatalf("decode group: %v %s", err, rec.Body.String())
	}
	return g
}

func (th *gmHarness) createGroup(token, name, ext string, members ...string) gmGroup {
	th.t.Helper()
	rec := th.scim(th.gm, token, http.MethodPost, "/scim/v2/Groups", gmGroupJSON(name, ext, members...))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("create group: %d %s", rec.Code, rec.Body.String())
	}
	return decodeGM(th.t, rec)
}

func (th *gmHarness) patchGroup(token, id string, want int, ops ...string) gmGroup {
	th.t.Helper()
	rec := th.scim(th.gm, token, http.MethodPatch, "/scim/v2/Groups/"+id, gmPatch(ops...))
	if rec.Code != want {
		th.t.Fatalf("patch group: %d %s", rec.Code, rec.Body.String())
	}
	if want != http.StatusOK {
		return gmGroup{}
	}
	return decodeGM(th.t, rec)
}

func (th *gmHarness) scalar(sql string, args ...any) string {
	th.t.Helper()
	var out string
	if err := th.admin.QueryRow(th.ctx, sql, args...).Scan(&out); err != nil {
		th.t.Fatalf("%s: %v", sql, err)
	}
	return out
}

func (th *gmHarness) roles(w scimWS, userID string) string {
	return th.scalar(`
		SELECT COALESCE(string_agg(r.key, ',' ORDER BY r.key), '')
		  FROM workspace_role_bindings b JOIN roles r ON r.id = b.role_id
		 WHERE b.workspace_id = $1::uuid AND b.user_id = $2::uuid`, w.ws.ID, userID)
}

func (th *gmHarness) memberRows(groupID string) string {
	return th.scalar(`SELECT COALESCE(string_agg(user_id::text, ',' ORDER BY user_id), '') FROM workspace_group_members WHERE group_id = $1::uuid`, groupID)
}

func (th *gmHarness) userGroupRows(w scimWS, userID string) string {
	return th.scalar(`SELECT count(*)::text FROM workspace_group_members WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, w.ws.ID, userID)
}

func (th *gmHarness) localGroup(h http.Handler, w scimWS, name string) string {
	th.t.Helper()
	rec := th.local(h, w, http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"`+name+`"}`)
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("local group: %d %s", rec.Code, rec.Body.String())
	}
	var g identity.Group
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	return g.ID
}

// park publishes a gate targeting groups and users in w, starts it as
// the owner (the requester and only admin), claims, and returns the
// execution id.
func (th *gmHarness) park(w scimWS, users, groups []string) string {
	th.t.Helper()
	th.seq++
	wf := createWorkflow(th.t, th.gm, th.owner, w.tenant, w.ws, targetedGateYAML(fmt.Sprintf("gm-gate-%d", th.seq), users, groups))
	body, _ := json.Marshal(map[string]any{"revision": wf.Draft.Revision, "note": "gm"})
	rec := th.local(th.gm, w, http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", string(body))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	var pub publishResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	exec := startExecution(th.t, th.gm, th.owner, w.tenant, w.ws, wf.Workflow.ID, pub.Version.ID)
	th.local(th.gm, w, http.MethodPost, "/api/v1/jobs/claim", fmt.Sprintf(`{"workerId":"gm-%d","leaseSeconds":5}`, th.seq))
	if got := th.gate(exec.ID); got != "pending" {
		th.t.Fatalf("gate did not park: approval status %q", got)
	}
	return exec.ID
}

// gate is the approval status for the execution's gate.
func (th *gmHarness) gate(executionID string) string {
	return th.scalar(`SELECT COALESCE((SELECT status FROM approvals WHERE execution_id = $1::uuid ORDER BY created_at DESC LIMIT 1), '')`, executionID)
}

type gmExec struct {
	Status              string         `json:"status"`
	StatusReason        string         `json:"statusReason"`
	StatusReasonDetails map[string]any `json:"statusReasonDetails"`
}

func (th *gmHarness) execution(w scimWS, executionID string) gmExec {
	th.t.Helper()
	rec := th.local(th.gm, w, http.MethodGet, "/api/v1/executions/"+executionID, "")
	if rec.Code != http.StatusOK {
		th.t.Fatalf("execution: %d %s", rec.Code, rec.Body.String())
	}
	var e gmExec
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	return e
}

// assertClosedNoDecider checks the existing no-eligible-decider close:
// approval canceled with requirement_unresolvable, event cause
// no_eligible_decider, execution failed with the same reason and cause.
func (th *gmHarness) assertClosedNoDecider(w scimWS, executionID string) {
	th.t.Helper()
	got := th.scalar(`
		SELECT status || '|' || COALESCE(close_reason, '') FROM approvals
		 WHERE execution_id = $1::uuid ORDER BY created_at DESC LIMIT 1`, executionID)
	if got != "canceled|requirement_unresolvable" {
		th.t.Fatalf("approval = %q", got)
	}
	cause := th.scalar(`
		SELECT COALESCE(e.details->>'reason', '') || '|' || COALESCE(e.details->>'cause', '')
		  FROM approval_events e JOIN approvals a ON a.id = e.approval_id
		 WHERE a.execution_id = $1::uuid AND e.event_type = 'canceled'`, executionID)
	if cause != "requirement_unresolvable|no_eligible_decider" {
		th.t.Fatalf("cancel event = %q", cause)
	}
	e := th.execution(w, executionID)
	if e.Status != "failed" || e.StatusReason != "requirement_unresolvable" || e.StatusReasonDetails["cause"] != "no_eligible_decider" {
		th.t.Fatalf("execution = %+v", e)
	}
}

func (th *gmHarness) assertWaiting(w scimWS, executionID string) {
	th.t.Helper()
	if got := th.gate(executionID); got != "pending" {
		th.t.Fatalf("gate = %q, want pending", got)
	}
	if e := th.execution(w, executionID); e.Status != "waiting" {
		th.t.Fatalf("execution = %+v, want waiting", e)
	}
}

func (th *gmHarness) groupAudits(w scimWS, action, groupID string) []map[string]any {
	th.t.Helper()
	rows, err := th.admin.Query(th.ctx, `
		SELECT COALESCE(actor_id::text, ''), details_redacted::text, host_context_redacted::text
		  FROM audit_events
		 WHERE workspace_id = $1::uuid AND action = $2 AND resource_id = $3::uuid
		 ORDER BY occurred_at, id`, w.ws.ID, action, groupID)
	if err != nil {
		th.t.Fatal(err)
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var actor, details, host string
		if err := rows.Scan(&actor, &details, &host); err != nil {
			th.t.Fatal(err)
		}
		m := map[string]any{}
		_ = json.Unmarshal([]byte(details), &m)
		m["_actor"] = actor
		m["_raw"] = details + host
		out = append(out, m)
	}
	return out
}

func TestScimGroupsModeLifecycle(t *testing.T) {
	th := newGMHarness(t)
	w := th.workspace()
	tokID, tok := th.mint(w)
	alice, bob := th.user(tok, "Alice"), th.user(tok, "Bob")
	ext := th.uniq("okta-grp")

	g := th.createGroup(tok, "Finance Approvers", ext, alice)
	if g.DisplayName != "Finance Approvers" || g.ExternalID != ext || strings.Join(g.memberIDs(), ",") != alice {
		t.Fatalf("created = %+v", g)
	}
	if th.memberRows(g.ID) != alice {
		t.Fatalf("member rows = %q", th.memberRows(g.ID))
	}
	// Group member changes never touch roles.
	if th.roles(w, alice) != authz.RoleApprover || th.roles(w, bob) != authz.RoleApprover {
		t.Fatal("group create changed roles")
	}

	// GET, filters, and list.
	if rec := th.scim(th.gm, tok, http.MethodGet, "/scim/v2/Groups/"+g.ID, ""); rec.Code != http.StatusOK || decodeGM(t, rec).ID != g.ID {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	for _, f := range []string{`displayName eq "finance approvers"`, `externalId eq "` + ext + `"`, `id eq "` + g.ID + `"`} {
		rec := th.scim(th.gm, tok, http.MethodGet, "/scim/v2/Groups?filter="+urlQuery(f), "")
		var list struct {
			TotalResults int       `json:"totalResults"`
			Resources    []gmGroup `json:"Resources"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &list)
		if rec.Code != http.StatusOK || list.TotalResults != 1 || len(list.Resources) != 1 || list.Resources[0].ID != g.ID {
			t.Fatalf("filter %s: %d %s", f, rec.Code, rec.Body.String())
		}
	}

	// PATCH: rename, add, remove.
	g = th.patchGroup(tok, g.ID, http.StatusOK, gmRenameOp("Finance Deciders"), gmMembersOp("add", bob))
	if g.DisplayName != "Finance Deciders" || len(g.Members) != 2 || g.ExternalID != ext {
		t.Fatalf("patched = %+v", g)
	}
	g = th.patchGroup(tok, g.ID, http.StatusOK, gmMembersOp("remove", alice))
	if strings.Join(g.memberIDs(), ",") != bob || th.memberRows(g.ID) != bob {
		t.Fatalf("after remove = %+v rows %q", g, th.memberRows(g.ID))
	}
	if th.roles(w, alice) != authz.RoleApprover {
		t.Fatal("group member remove changed roles")
	}
	if rec := th.scim(th.gm, tok, http.MethodGet, "/scim/v2/Users/"+alice, ""); !decodeScimUser(t, rec).Active {
		t.Fatal("group member remove deactivated the user")
	}

	// PUT: rename and replace members; externalId never rewritten.
	rec := th.scim(th.gm, tok, http.MethodPut, "/scim/v2/Groups/"+g.ID, gmGroupJSON("Finance", "other-ext", alice))
	if rec.Code != http.StatusOK {
		t.Fatalf("put: %d %s", rec.Code, rec.Body.String())
	}
	g = decodeGM(t, rec)
	if g.DisplayName != "Finance" || g.ExternalID != ext || strings.Join(g.memberIDs(), ",") != alice {
		t.Fatalf("put = %+v", g)
	}

	// Local view: managedBy scim on list and detail.
	rec = th.local(th.gm, w, http.MethodGet, "/api/v1/workspace/groups/"+g.ID, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"managedBy":"scim"`) {
		t.Fatalf("local detail: %d %s", rec.Code, rec.Body.String())
	}
	localID := th.localGroup(th.gm, w, th.uniq("Local"))
	rec = th.local(th.gm, w, http.MethodGet, "/api/v1/workspace/groups", "")
	var list struct {
		Items []struct {
			ID        string  `json:"id"`
			ManagedBy *string `json:"managedBy"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	seen := 0
	for _, it := range list.Items {
		switch it.ID {
		case g.ID:
			if it.ManagedBy == nil || *it.ManagedBy != "scim" {
				t.Fatalf("list managedBy for scim group = %v", it.ManagedBy)
			}
			seen++
		case localID:
			if it.ManagedBy != nil {
				t.Fatalf("list managedBy for local group = %v", *it.ManagedBy)
			}
			seen++
		}
	}
	if seen != 2 || !strings.Contains(rec.Body.String(), `"managedBy":null`) {
		t.Fatalf("list: %s", rec.Body.String())
	}
	// groupsMode on the token list.
	rec = th.local(th.gm, w, http.MethodGet, "/api/v1/workspace/scim-tokens", "")
	if !strings.Contains(rec.Body.String(), `"groupsMode":"groups"`) {
		t.Fatalf("token list (groups): %s", rec.Body.String())
	}
	rec = th.local(th.ws, w, http.MethodGet, "/api/v1/workspace/scim-tokens", "")
	if !strings.Contains(rec.Body.String(), `"groupsMode":"workspaces"`) {
		t.Fatalf("token list (workspaces): %s", rec.Body.String())
	}

	// DELETE hard-deletes the group and its member rows.
	if rec := th.scim(th.gm, tok, http.MethodDelete, "/scim/v2/Groups/"+g.ID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if th.scalar(`SELECT count(*)::text FROM workspace_groups WHERE id = $1::uuid`, g.ID) != "0" || th.memberRows(g.ID) != "" {
		t.Fatal("delete left rows")
	}
	if rec := th.scim(th.gm, tok, http.MethodGet, "/scim/v2/Groups/"+g.ID, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("get deleted: %d", rec.Code)
	}
	if th.roles(w, alice) != authz.RoleApprover || th.roles(w, bob) != authz.RoleApprover {
		t.Fatal("group delete changed roles")
	}

	// Audit: every change has the token as actor and no token value.
	for _, action := range []string{identity.AuditGroupCreate, identity.AuditGroupRename, identity.AuditGroupMemberAdd, identity.AuditGroupMemberRemove, identity.AuditGroupDelete} {
		rows := th.groupAudits(w, action, g.ID)
		if len(rows) == 0 {
			t.Fatalf("no %s audit row", action)
		}
		for _, r := range rows {
			if r["_actor"] != "" || r["tokenId"] != tokID || r["via"] != "scim_token" || r["groupId"] != g.ID {
				t.Fatalf("%s audit = %v", action, r)
			}
			raw := r["_raw"].(string)
			if strings.Contains(raw, tok) || strings.Contains(raw, scim.TokenPrefix) || scim.ContainsToken(raw) {
				t.Fatalf("%s audit carries a token-shaped value", action)
			}
		}
	}
	if n := len(th.groupAudits(w, identity.AuditGroupMemberAdd, g.ID)); n != 3 {
		t.Fatalf("member_add audits = %d, want 3 (alice, bob, alice again)", n)
	}
	if strings.Contains(th.logs.String(), tok) {
		t.Fatal("token reached the log")
	}
}

func TestScimGroupsModeRefusals(t *testing.T) {
	th := newGMHarness(t)
	w := th.workspace()
	_, tok := th.mint(w)
	alice := th.user(tok, "Alice")
	g := th.createGroup(tok, th.uniq("Refusals"), "", alice)

	t.Run("non-member add is 400 and changes nothing", func(t *testing.T) {
		// A bound member this IdP never linked.
		subject := th.uniq("unlinked")
		m := putMember(t, th.gm, th.owner, w.tenant, w.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Unlinked","role_keys":["approver"]}`, scimIssuer, subject))
		// A linked user whose link is deactivated.
		gone := th.user(tok, "Gone")
		rec := th.scim(th.gm, tok, http.MethodPatch, "/scim/v2/Users/"+gone, `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("deactivate: %d", rec.Code)
		}
		bob := th.user(tok, "Bob")
		for _, id := range []string{m.User.ID, gone, "8b5a1f0e-0000-4000-8000-000000000001", "not-a-uuid"} {
			rec := th.scim(th.gm, tok, http.MethodPatch, "/scim/v2/Groups/"+g.ID, gmPatch(gmMembersOp("add", bob), gmMembersOp("add", id)))
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"scimType":"invalidValue"`) {
				t.Fatalf("add %s: %d %s", id, rec.Code, rec.Body.String())
			}
			if th.memberRows(g.ID) != alice {
				t.Fatalf("refused add was not rolled back: %q", th.memberRows(g.ID))
			}
		}
		rec = th.scim(th.gm, tok, http.MethodPost, "/scim/v2/Groups", gmGroupJSON(th.uniq("WithBad"), "", m.User.ID))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("create with bad member: %d %s", rec.Code, rec.Body.String())
		}
		if th.roles(w, m.User.ID) != authz.RoleApprover {
			t.Fatal("refused add touched roles")
		}
	})

	t.Run("name clash is 409 uniqueness and renames nothing", func(t *testing.T) {
		localName := th.uniq("Payroll")
		localID := th.localGroup(th.gm, w, localName)
		rec := th.scim(th.gm, tok, http.MethodPost, "/scim/v2/Groups", gmGroupJSON(strings.ToUpper(localName), ""))
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"scimType":"uniqueness"`) {
			t.Fatalf("create clash: %d %s", rec.Code, rec.Body.String())
		}
		rec = th.scim(th.gm, tok, http.MethodPatch, "/scim/v2/Groups/"+g.ID, gmPatch(gmRenameOp(localName)))
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"scimType":"uniqueness"`) {
			t.Fatalf("rename clash: %d %s", rec.Code, rec.Body.String())
		}
		if th.scalar(`SELECT display_name FROM workspace_groups WHERE id = $1::uuid`, localID) != localName {
			t.Fatal("local group renamed")
		}
		if th.scalar(`SELECT count(*)::text FROM workspace_groups WHERE workspace_id = $1::uuid AND lower(display_name) = lower($2)`, w.ws.ID, localName) != "1" {
			t.Fatal("clash created a second group")
		}
		ext := th.uniq("dup-ext")
		th.createGroup(tok, th.uniq("ExtA"), ext)
		rec = th.scim(th.gm, tok, http.MethodPost, "/scim/v2/Groups", gmGroupJSON(th.uniq("ExtB"), ext))
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"scimType":"uniqueness"`) {
			t.Fatalf("externalId clash: %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("instance token is 403 on every /Groups call; /Users unchanged", func(t *testing.T) {
		for _, c := range []struct{ method, path, body string }{
			{http.MethodGet, "/scim/v2/Groups", ""},
			{http.MethodGet, "/scim/v2/Groups/" + g.ID, ""},
			{http.MethodPost, "/scim/v2/Groups", gmGroupJSON("Env", "")},
			{http.MethodPut, "/scim/v2/Groups/" + g.ID, gmGroupJSON("Env", "")},
			{http.MethodPatch, "/scim/v2/Groups/" + g.ID, gmPatch(gmRenameOp("Env"))},
			{http.MethodDelete, "/scim/v2/Groups/" + g.ID, ""},
			{http.MethodPatch, "/scim/v2/Groups/" + w.ws.ID, scimGroupPatch("add", alice)},
		} {
			rec := th.scim(th.gm, scimTestToken, c.method, c.path, c.body)
			if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "workspace's SCIM token") {
				t.Fatalf("%s %s: %d %s", c.method, c.path, rec.Code, rec.Body.String())
			}
		}
		if th.memberRows(g.ID) != alice {
			t.Fatal("refused instance call changed the group")
		}
		if rec := th.scim(th.gm, scimTestToken, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusOK {
			t.Fatalf("env list users: %d", rec.Code)
		}
		rec := th.scim(th.gm, scimTestToken, http.MethodPost, "/scim/v2/Users", scimUserJSON(th.uniq("env"), th.uniq("env-ext"), "Env User"))
		if rec.Code != http.StatusCreated {
			t.Fatalf("env post user: %d %s", rec.Code, rec.Body.String())
		}
		// Workspaces mode: the instance token still lists workspaces.
		if rec := th.scim(th.ws, scimTestToken, http.MethodGet, "/scim/v2/Groups/"+w.ws.ID, ""); rec.Code != http.StatusOK {
			t.Fatalf("workspaces-mode env group: %d", rec.Code)
		}
	})
}

func TestScimGroupsModeLocalEditsAndModeSwitch(t *testing.T) {
	th := newGMHarness(t)
	w := th.workspace()
	_, tok := th.mint(w)
	alice, bob := th.user(tok, "Alice"), th.user(tok, "Bob")
	ext := th.uniq("round-trip")
	g := th.createGroup(tok, th.uniq("Managed"), ext, alice)
	base := "/api/v1/workspace/groups/" + g.ID

	// Groups mode: every local change is 409 group_managed_by_scim.
	for _, c := range []struct{ method, path, body string }{
		{http.MethodPatch, base, `{"displayName":"Local rename"}`},
		{http.MethodPost, base + "/members", `{"userId":"` + bob + `"}`},
		{http.MethodDelete, base + "/members/" + alice, ""},
		{http.MethodDelete, base, ""},
	} {
		rec := th.local(th.gm, w, c.method, c.path, c.body)
		assertProblem(t, rec, http.StatusConflict, CodeGroupManagedBySCIM, "")
	}
	if th.memberRows(g.ID) != alice || th.scalar(`SELECT display_name FROM workspace_groups WHERE id = $1::uuid`, g.ID) != g.DisplayName {
		t.Fatal("refused local change changed the group")
	}
	// Local groups stay editable in groups mode.
	localID := th.localGroup(th.gm, w, th.uniq("Local"))
	if rec := th.local(th.gm, w, http.MethodPost, "/api/v1/workspace/groups/"+localID+"/members", `{"userId":"`+bob+`"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("local group add in groups mode: %d %s", rec.Code, rec.Body.String())
	}
	// The token cannot see or touch the local group.
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		if rec := th.scim(th.gm, tok, method, "/scim/v2/Groups/"+localID, ""); rec.Code != http.StatusNotFound {
			t.Fatalf("token %s local group: %d", method, rec.Code)
		}
	}
	if rec := th.scim(th.gm, tok, http.MethodPatch, "/scim/v2/Groups/"+localID, gmPatch(gmMembersOp("remove", bob))); rec.Code != http.StatusNotFound {
		t.Fatalf("token patch local group: %d", rec.Code)
	}
	if th.memberRows(localID) != bob {
		t.Fatal("token touched a local group")
	}

	// Workspaces mode: marker kept, not enforced.
	localName := th.uniq("Renamed locally")
	if rec := th.local(th.ws, w, http.MethodPatch, base, `{"displayName":"`+localName+`"}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"managedBy":"scim"`) {
		t.Fatalf("workspaces-mode rename: %d %s", rec.Code, rec.Body.String())
	}
	if rec := th.local(th.ws, w, http.MethodPost, base+"/members", `{"userId":"`+bob+`"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("workspaces-mode add: %d %s", rec.Code, rec.Body.String())
	}
	if rec := th.local(th.ws, w, http.MethodDelete, base+"/members/"+alice, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("workspaces-mode remove: %d %s", rec.Code, rec.Body.String())
	}
	// Workspaces mode: the workspace token's /Groups is the workspace again.
	if rec := th.scim(th.ws, tok, http.MethodGet, "/scim/v2/Groups/"+w.ws.ID, ""); rec.Code != http.StatusOK {
		t.Fatalf("workspaces-mode token group: %d", rec.Code)
	}

	// Back to groups mode: re-attached by externalId, same id, enforced again.
	rec := th.scim(th.gm, tok, http.MethodGet, "/scim/v2/Groups?filter="+urlQuery(`externalId eq "`+ext+`"`), "")
	var list struct {
		Resources []gmGroup `json:"Resources"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if rec.Code != http.StatusOK || len(list.Resources) != 1 || list.Resources[0].ID != g.ID || list.Resources[0].DisplayName != localName {
		t.Fatalf("re-attach: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Join(list.Resources[0].memberIDs(), ",") != bob {
		t.Fatalf("re-attached members = %v", list.Resources[0].memberIDs())
	}
	assertProblem(t, th.local(th.gm, w, http.MethodPatch, base, `{"displayName":"Again"}`), http.StatusConflict, CodeGroupManagedBySCIM, "")
	g2 := th.patchGroup(tok, g.ID, http.StatusOK, gmRenameOp(g.DisplayName), gmMembersOp("remove", bob), gmMembersOp("add", alice))
	if g2.ID != g.ID || g2.DisplayName != g.DisplayName || g2.ExternalID != ext || strings.Join(g2.memberIDs(), ",") != alice {
		t.Fatalf("after re-attach patch = %+v", g2)
	}
	// Workspaces mode delete is allowed too (no data-loss check needed
	// beyond the explicit delete).
	if rec := th.local(th.ws, w, http.MethodDelete, base, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("workspaces-mode delete: %d", rec.Code)
	}
}

func TestScimGroupsModeIsolation(t *testing.T) {
	th := newGMHarness(t)
	a, b := th.workspace(), th.workspace()
	_, tokA := th.mint(a)
	_, tokB := th.mint(b)
	bobB := th.user(tokB, "BobB")
	gB := th.createGroup(tokB, th.uniq("B group"), th.uniq("b-ext"), bobB)
	aliceA := th.user(tokA, "AliceA")

	for _, c := range []struct{ method, body string }{
		{http.MethodGet, ""},
		{http.MethodPut, gmGroupJSON("Hijack", "")},
		{http.MethodPatch, gmPatch(gmMembersOp("add", aliceA))},
		{http.MethodPatch, gmPatch(gmMembersOp("remove", bobB))},
		{http.MethodDelete, ""},
	} {
		if rec := th.scim(th.gm, tokA, c.method, "/scim/v2/Groups/"+gB.ID, c.body); rec.Code != http.StatusNotFound {
			t.Fatalf("token A %s B's group: %d %s", c.method, rec.Code, rec.Body.String())
		}
	}
	rec := th.scim(th.gm, tokA, http.MethodGet, "/scim/v2/Groups", "")
	if strings.Contains(rec.Body.String(), gB.ID) {
		t.Fatal("token A listed B's group")
	}
	// A cannot add B's user to its own group either.
	gA := th.createGroup(tokA, th.uniq("A group"), "")
	if rec := th.scim(th.gm, tokA, http.MethodPatch, "/scim/v2/Groups/"+gA.ID, gmPatch(gmMembersOp("add", bobB))); rec.Code != http.StatusBadRequest {
		t.Fatalf("A adds B's user: %d", rec.Code)
	}
	if th.memberRows(gB.ID) != bobB || th.scalar(`SELECT display_name FROM workspace_groups WHERE id = $1::uuid`, gB.ID) != gB.DisplayName {
		t.Fatal("B's group changed")
	}
	// Same name in two workspaces is fine.
	th.createGroup(tokA, gB.DisplayName, "")
}

func TestScimGroupsModeRenameKeepsGateTarget(t *testing.T) {
	th := newGMHarness(t)
	w := th.workspace()
	_, tok := th.mint(w)
	alice := th.user(tok, "Alice")
	ext := th.uniq("slug-ext")
	g := th.createGroup(tok, th.uniq("Deciders"), ext, alice)
	execID := th.park(w, nil, []string{g.ID})
	th.patchGroup(tok, g.ID, http.StatusOK, gmRenameOp(th.uniq("Renamed deciders")))
	if got := th.scalar(`
		SELECT COALESCE(string_agg(ag.group_id::text, ','), '') FROM approval_approver_groups ag
		  JOIN approvals a ON a.id = ag.approval_id WHERE a.execution_id = $1::uuid`, execID); got != g.ID {
		t.Fatalf("snapshot groups after rename = %q", got)
	}
	if th.scalar(`SELECT external_id FROM workspace_groups WHERE id = $1::uuid`, g.ID) != ext {
		t.Fatal("externalId rewritten")
	}
	th.assertWaiting(w, execID)
}

func TestScimGroupsModeMidWaitGates(t *testing.T) {
	th := newGMHarness(t)
	w := th.workspace()
	_, tok := th.mint(w)

	t.Run("group delete leaves no decider: closed", func(t *testing.T) {
		alice := th.user(tok, "Alice")
		g := th.createGroup(tok, th.uniq("Only"), "", alice)
		execID := th.park(w, nil, []string{g.ID})
		if rec := th.scim(th.gm, tok, http.MethodDelete, "/scim/v2/Groups/"+g.ID, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("delete: %d", rec.Code)
		}
		th.assertClosedNoDecider(w, execID)
	})

	t.Run("group shrink: waits while another target qualifies, then closes", func(t *testing.T) {
		m1, m2 := th.user(tok, "M1"), th.user(tok, "M2")
		g1 := th.createGroup(tok, th.uniq("G1"), "", m1)
		g2 := th.createGroup(tok, th.uniq("G2"), "", m2)
		execID := th.park(w, nil, []string{g1.ID, g2.ID})
		th.patchGroup(tok, g1.ID, http.StatusOK, gmMembersOp("remove", m1))
		th.assertWaiting(w, execID)
		th.patchGroup(tok, g2.ID, http.StatusOK, gmMembersOp("remove", m2))
		th.assertClosedNoDecider(w, execID)
	})

	t.Run("group delete with a named user still eligible: keeps waiting", func(t *testing.T) {
		m, named := th.user(tok, "M"), th.user(tok, "Named")
		g := th.createGroup(tok, th.uniq("Deleted"), "", m)
		execID := th.park(w, []string{named}, []string{g.ID})
		if rec := th.scim(th.gm, tok, http.MethodDelete, "/scim/v2/Groups/"+g.ID, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("delete: %d", rec.Code)
		}
		th.assertWaiting(w, execID)
	})

	t.Run("local delete uses the same path", func(t *testing.T) {
		m := th.user(tok, "LocalM")
		localID := th.localGroup(th.gm, w, th.uniq("LocalOnly"))
		if rec := th.local(th.gm, w, http.MethodPost, "/api/v1/workspace/groups/"+localID+"/members", `{"userId":"`+m+`"}`); rec.Code != http.StatusNoContent {
			t.Fatalf("add: %d", rec.Code)
		}
		execID := th.park(w, nil, []string{localID})
		if rec := th.local(th.gm, w, http.MethodDelete, "/api/v1/workspace/groups/"+localID+"/members/"+m, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("local remove: %d", rec.Code)
		}
		th.assertClosedNoDecider(w, execID)
	})
}

func TestScimGroupsModeMembershipLoss(t *testing.T) {
	th := newGMHarness(t)
	w := th.workspace()
	_, tok := th.mint(w)
	deactivate := func(h http.Handler, id string, active bool) {
		t.Helper()
		rec := th.scim(h, tok, http.MethodPatch, "/scim/v2/Users/"+id, fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":%t}]}`, active))
		if rec.Code != http.StatusOK {
			t.Fatalf("active=%t: %d %s", active, rec.Code, rec.Body.String())
		}
	}

	t.Run("groups mode active:false removes local and managed rows and re-checks gates", func(t *testing.T) {
		m := th.user(tok, "Leaver")
		g := th.createGroup(tok, th.uniq("Managed"), "", m)
		localID := th.localGroup(th.gm, w, th.uniq("Local"))
		if rec := th.local(th.gm, w, http.MethodPost, "/api/v1/workspace/groups/"+localID+"/members", `{"userId":"`+m+`"}`); rec.Code != http.StatusNoContent {
			t.Fatalf("local add: %d", rec.Code)
		}
		execGroup := th.park(w, nil, []string{g.ID})
		execNamed := th.park(w, []string{m}, nil)
		deactivate(th.gm, m, false)
		if th.userGroupRows(w, m) != "0" || th.roles(w, m) != "" {
			t.Fatalf("after active:false rows=%s roles=%q", th.userGroupRows(w, m), th.roles(w, m))
		}
		th.assertClosedNoDecider(w, execGroup)
		th.assertClosedNoDecider(w, execNamed)

		// Reactivation restores the default role only.
		deactivate(th.gm, m, true)
		if th.roles(w, m) != authz.RoleApprover || th.userGroupRows(w, m) != "0" {
			t.Fatalf("after active:true roles=%q rows=%s", th.roles(w, m), th.userGroupRows(w, m))
		}
		if th.gate(execGroup) != "canceled" {
			t.Fatal("reactivation reopened a closed gate")
		}
	})

	t.Run("workspaces mode active:false re-checks gates the same way", func(t *testing.T) {
		m, other := th.user(tok, "WSLeaver"), th.user(tok, "WSOther")
		localA := th.localGroup(th.ws, w, th.uniq("WS A"))
		localB := th.localGroup(th.ws, w, th.uniq("WS B"))
		for _, c := range [][2]string{{localA, m}, {localB, m}, {localB, other}} {
			if rec := th.local(th.ws, w, http.MethodPost, "/api/v1/workspace/groups/"+c[0]+"/members", `{"userId":"`+c[1]+`"}`); rec.Code != http.StatusNoContent {
				t.Fatalf("add: %d", rec.Code)
			}
		}
		execA := th.park(w, nil, []string{localA})
		execB := th.park(w, nil, []string{localB})
		deactivate(th.ws, m, false)
		th.assertClosedNoDecider(w, execA)
		th.assertWaiting(w, execB)
		if th.memberRows(localB) != other {
			t.Fatalf("localB rows = %q", th.memberRows(localB))
		}
	})

	t.Run("admin removal and SCIM DELETE use the same path", func(t *testing.T) {
		m1, m2 := th.user(tok, "Removed"), th.user(tok, "Deleted")
		g1 := th.createGroup(tok, th.uniq("R1"), "", m1)
		g2 := th.createGroup(tok, th.uniq("R2"), "", m2)
		exec1 := th.park(w, nil, []string{g1.ID})
		exec2 := th.park(w, nil, []string{g2.ID})
		if rec := th.local(th.gm, w, http.MethodDelete, "/api/v1/workspace/members/"+m1, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("admin remove: %d %s", rec.Code, rec.Body.String())
		}
		if rec := th.scim(th.gm, tok, http.MethodDelete, "/scim/v2/Users/"+m2, ""); rec.Code != http.StatusNoContent {
			t.Fatalf("scim delete: %d", rec.Code)
		}
		if th.userGroupRows(w, m1) != "0" || th.userGroupRows(w, m2) != "0" {
			t.Fatal("membership loss left group rows")
		}
		th.assertClosedNoDecider(w, exec1)
		th.assertClosedNoDecider(w, exec2)
	})
}

func TestScimGroupsModeLastAdminGuard(t *testing.T) {
	th := newGMHarness(t)
	w := th.workspace()
	_, tok := th.mint(w)
	subject := th.uniq("soleadmin")
	rec := th.scim(th.gm, tok, http.MethodPost, "/scim/v2/Users", scimUserJSON(subject, "", "Sole Admin"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("post: %d", rec.Code)
	}
	sole := decodeScimUser(t, rec).ID
	putMember(t, th.gm, th.owner, w.tenant, w.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Sole Admin","role_keys":["admin"]}`, scimIssuer, subject))
	g := th.createGroup(tok, th.uniq("Admins"), "", sole)
	if _, err := th.admin.Exec(th.ctx, `DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, w.ws.ID, th.owner.ID); err != nil {
		t.Fatal(err)
	}
	// Group changes never touch roles, so removing and deleting succeed
	// and the sole admin stays admin.
	th.patchGroup(tok, g.ID, http.StatusOK, gmMembersOp("remove", sole))
	if rec := th.scim(th.gm, tok, http.MethodDelete, "/scim/v2/Groups/"+g.ID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if th.roles(w, sole) != authz.RoleAdmin {
		t.Fatal("group change removed the admin role")
	}
	// Membership loss is still guarded.
	if rec := th.scim(th.gm, tok, http.MethodPatch, "/scim/v2/Users/"+sole, `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}`); rec.Code != http.StatusConflict {
		t.Fatalf("deactivate sole admin: %d", rec.Code)
	}
	if rec := th.scim(th.gm, tok, http.MethodDelete, "/scim/v2/Users/"+sole, ""); rec.Code != http.StatusConflict {
		t.Fatalf("delete sole admin: %d", rec.Code)
	}
	if th.roles(w, sole) != authz.RoleAdmin {
		t.Fatal("refused removal changed roles")
	}
}
