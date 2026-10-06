package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

type groupEnv struct {
	h      http.Handler
	admin  identity.User
	ws     identity.Workspace
	tenant identity.Tenant
}

func newGroupEnv(t *testing.T) groupEnv {
	t.Helper()
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	return groupEnv{h: h, admin: admin, ws: ws, tenant: tenant}
}

func (e groupEnv) do(t *testing.T, actor identity.User, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = workspaceRequest(method, path, nil, actor, e.tenant, e.ws)
	} else {
		req = workspaceRequest(method, path, strings.NewReader(body), actor, e.tenant, e.ws)
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e groupEnv) member(t *testing.T, subject, name string, roles ...string) identity.User {
	t.Helper()
	keys, _ := json.Marshal(roles)
	m := putMember(t, e.h, e.admin, e.tenant, e.ws, `{"issuer":"https://idp.example","external_subject":"`+subject+`","display_name":"`+name+`","role_keys":`+string(keys)+`}`)
	return m.User
}

func (e groupEnv) create(t *testing.T, name string) identity.Group {
	t.Helper()
	rec := e.do(t, e.admin, http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"`+name+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create group: %d %s", rec.Code, rec.Body.String())
	}
	var g identity.Group
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func assertFieldPath(t *testing.T, p Problem, path, code string) {
	t.Helper()
	if len(p.Errors) != 1 || p.Errors[0].Path != path || p.Errors[0].Code != code {
		t.Fatalf("errors = %+v, want path %s code %s", p.Errors, path, code)
	}
}

func TestWorkspaceGroupsAdminLifecycle(t *testing.T) {
	e := newGroupEnv(t)
	approver := e.member(t, "grp-approver", "Approver", authz.RoleApprover)
	editor := e.member(t, "grp-editor", "editor", authz.RoleEditor)

	g := e.create(t, "  Change Board ")
	if g.DisplayName != "Change Board" || g.ID == "" {
		t.Fatalf("created %+v", g)
	}
	base := "/api/v1/workspace/groups/" + g.ID
	for _, id := range []string{approver.ID, approver.ID, editor.ID} {
		rec := e.do(t, e.admin, http.MethodPost, base+"/members", `{"userId":"`+id+`"}`)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("add member: %d %s", rec.Code, rec.Body.String())
		}
	}

	rec := e.do(t, e.admin, http.MethodGet, base, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "email") {
		t.Fatalf("group detail mentions email: %s", rec.Body.String())
	}
	var d identity.GroupDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.MemberCount != 2 || len(d.Members) != 2 {
		t.Fatalf("detail %+v", d)
	}
	if d.Members[0].UserID != approver.ID || !d.Members[0].CanApprove {
		t.Fatalf("approver %+v", d.Members[0])
	}
	if d.Members[1].UserID != editor.ID || d.Members[1].CanApprove {
		t.Fatalf("editor %+v", d.Members[1])
	}

	rec = e.do(t, e.admin, http.MethodGet, "/api/v1/workspace/groups?limit=10", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var list struct {
		Items []identity.Group `json:"items"`
		Limit int              `json:"limit"`
		Next  string           `json:"next"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].MemberCount != 2 || list.Limit != 10 {
		t.Fatalf("list %+v", list)
	}

	rec = e.do(t, e.admin, http.MethodPatch, base, `{"displayName":"CAB"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"displayName":"CAB"`) {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}

	for i := 0; i < 2; i++ {
		rec = e.do(t, e.admin, http.MethodDelete, base+"/members/"+editor.ID, "")
		if rec.Code != http.StatusNoContent {
			t.Fatalf("remove member: %d %s", rec.Code, rec.Body.String())
		}
	}

	rec = e.do(t, e.admin, http.MethodDelete, base, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	rec = e.do(t, e.admin, http.MethodGet, base, "")
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
}

func TestWorkspaceGroupNameTakenIsCaseInsensitive(t *testing.T) {
	e := newGroupEnv(t)
	e.create(t, "Ops Leads")
	other := e.create(t, "Security")

	rec := e.do(t, e.admin, http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"ops LEADS"}`)
	assertFieldPath(t, assertProblem(t, rec, http.StatusConflict, CodeGroupNameTaken, ""), "displayName", CodeGroupNameTaken)

	rec = e.do(t, e.admin, http.MethodPatch, "/api/v1/workspace/groups/"+other.ID, `{"displayName":"OPS leads"}`)
	assertFieldPath(t, assertProblem(t, rec, http.StatusConflict, CodeGroupNameTaken, ""), "displayName", CodeGroupNameTaken)

	for _, body := range []string{`{"displayName":"   "}`, `{}`, `{"displayName":"` + strings.Repeat("x", 129) + `"}`} {
		rec = e.do(t, e.admin, http.MethodPost, "/api/v1/workspace/groups", body)
		assertFieldPath(t, assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, ""), "displayName", CodeInvalidRequest)
	}
}

func TestWorkspaceGroupMemberMustBeActiveWorkspaceMember(t *testing.T) {
	e := newGroupEnv(t)
	g := e.create(t, "Approvers")
	base := "/api/v1/workspace/groups/" + g.ID + "/members"

	// A user who exists but has no binding in this workspace.
	outsider := e.member(t, "grp-outsider", "Outsider", authz.RoleViewer)
	rec := e.do(t, e.admin, http.MethodDelete, "/api/v1/workspace/members/"+outsider.ID, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("remove outsider: %d %s", rec.Code, rec.Body.String())
	}
	for _, id := range []string{outsider.ID, "11111111-1111-4111-8111-111111111111"} {
		rec = e.do(t, e.admin, http.MethodPost, base, `{"userId":"`+id+`"}`)
		assertFieldPath(t, assertProblem(t, rec, http.StatusBadRequest, CodeGroupMemberNotInWorkspace, ""), "userId", CodeGroupMemberNotInWorkspace)
	}
	rec = e.do(t, e.admin, http.MethodPost, base, `{"userId":"nope"}`)
	assertFieldPath(t, assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, ""), "userId", CodeInvalidRequest)

	rec = e.do(t, e.admin, http.MethodPost, "/api/v1/workspace/groups/22222222-2222-4222-8222-222222222222/members", `{"userId":"`+e.admin.ID+`"}`)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
}

func TestWorkspaceMemberRemovalDropsGroupRows(t *testing.T) {
	e := newGroupEnv(t)
	u := e.member(t, "grp-leaver", "Leaver", authz.RoleApprover)
	g := e.create(t, "Leavers")
	rec := e.do(t, e.admin, http.MethodPost, "/api/v1/workspace/groups/"+g.ID+"/members", `{"userId":"`+u.ID+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	rec = e.do(t, e.admin, http.MethodDelete, "/api/v1/workspace/members/"+u.ID, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("remove member: %d %s", rec.Code, rec.Body.String())
	}
	rec = e.do(t, e.admin, http.MethodGet, "/api/v1/workspace/groups/"+g.ID, "")
	var d identity.GroupDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if len(d.Members) != 0 || d.MemberCount != 0 {
		t.Fatalf("removed member still listed: %+v", d)
	}
}

func TestWorkspaceGroupsRequireAdminister(t *testing.T) {
	e := newGroupEnv(t)
	g := e.create(t, "Locked")
	target := e.member(t, "grp-target", "Target", authz.RoleApprover)
	for _, role := range []string{authz.RoleViewer, authz.RoleEditor, authz.RoleApprover} {
		actor := e.member(t, "grp-"+role, role, role)
		calls := []struct{ method, path, body string }{
			{http.MethodGet, "/api/v1/workspace/groups", ""},
			{http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"Nope"}`},
			{http.MethodGet, "/api/v1/workspace/groups/" + g.ID, ""},
			{http.MethodPatch, "/api/v1/workspace/groups/" + g.ID, `{"displayName":"Nope"}`},
			{http.MethodDelete, "/api/v1/workspace/groups/" + g.ID, ""},
			{http.MethodPost, "/api/v1/workspace/groups/" + g.ID + "/members", `{"userId":"` + target.ID + `"}`},
			{http.MethodDelete, "/api/v1/workspace/groups/" + g.ID + "/members/" + target.ID, ""},
		}
		for _, c := range calls {
			rec := e.do(t, actor, c.method, c.path, c.body)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("%s %s %s = %d %s", role, c.method, c.path, rec.Code, rec.Body.String())
			}
		}
	}
	rec := e.do(t, e.admin, http.MethodGet, "/api/v1/workspace/groups/"+g.ID, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"displayName":"Locked"`) || strings.Contains(rec.Body.String(), target.ID) {
		t.Fatalf("group changed by non-admins: %d %s", rec.Code, rec.Body.String())
	}
}

func TestWorkspaceGroupOtherTenantIsNotFound(t *testing.T) {
	e := newGroupEnv(t)
	g := e.create(t, "Tenant A")

	// The same admin also administers tenant B. Requests scoped to B must
	// not reach A's group: workspace scope comes from the server, never
	// from a group id.
	other := e.admin
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"globex","name":"Globex"}`, e.admin))
	if rec.Code != http.StatusCreated {
		t.Fatalf("tenant b: %d %s", rec.Code, rec.Body.String())
	}
	var tenantB identity.Tenant
	if err := json.Unmarshal(rec.Body.Bytes(), &tenantB); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"globex","workbench_key":"b","name":"B"}`, other))
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace b: %d %s", rec.Code, rec.Body.String())
	}
	var wsB identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
		t.Fatal(err)
	}
	eb := groupEnv{h: e.h, admin: other, ws: wsB, tenant: tenantB}
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/workspace/groups/" + g.ID, ""},
		{http.MethodPatch, "/api/v1/workspace/groups/" + g.ID, `{"displayName":"Stolen"}`},
		{http.MethodDelete, "/api/v1/workspace/groups/" + g.ID, ""},
		{http.MethodDelete, "/api/v1/workspace/groups/" + g.ID + "/members/" + e.admin.ID, ""},
	} {
		rec := eb.do(t, other, c.method, c.path, c.body)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	}
	rec = eb.do(t, other, http.MethodGet, "/api/v1/workspace/groups", "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), g.ID) {
		t.Fatalf("tenant B list leaks A: %d %s", rec.Code, rec.Body.String())
	}
}

func TestWorkspaceGroupsRefuseEmbedSessions(t *testing.T) {
	env := newEmbedEnv(t)
	// A stored session whose caps list workspace.administer is still
	// refused: the handler checks the embed binding before any cap.
	token, csrf := plantEmbedSession(t, env, []string{authz.PermWorkspaceAdminister, authz.PermApprovalDecide})
	g := "33333333-3333-4333-8333-333333333333"
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/workspace/groups", ""},
		{http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"Embed"}`},
		{http.MethodGet, "/api/v1/workspace/groups/" + g, ""},
		{http.MethodPatch, "/api/v1/workspace/groups/" + g, `{"displayName":"Embed"}`},
		{http.MethodDelete, "/api/v1/workspace/groups/" + g, ""},
		{http.MethodPost, "/api/v1/workspace/groups/" + g + "/members", `{"userId":"` + env.admin.ID + `"}`},
		{http.MethodDelete, "/api/v1/workspace/groups/" + g + "/members/" + env.admin.ID, ""},
	} {
		rec := httptest.NewRecorder()
		env.h.ServeHTTP(rec, sessionAPIRequest(c.method, c.path, c.body, token, csrf))
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	}
}
