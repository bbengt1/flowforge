package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Per-workspace SCIM tokens over real Postgres. Each test builds its own
// tenants and workspaces with unique slugs, so tests share the database
// without seeing each other's rows.

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type scimWSHarness struct {
	t        *testing.T
	ctx      context.Context
	h        http.Handler
	app      *pgxpool.Pool
	admin    *pgxpool.Pool
	sessions session.Store
	owner    identity.User
	n        int64
	seq      int
	logs     *lockedBuffer
}

type scimWS struct {
	tenant identity.Tenant
	ws     identity.Workspace
}

func newScimWSHarness(t *testing.T) *scimWSHarness {
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
	owner := identity.User{Issuer: scimIssuer, ExternalSubject: fmt.Sprintf("scimws-owner-%d", n), DisplayName: "Owner"}
	logs := &lockedBuffer{}
	sessions := session.NewPostgres(pool)
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:      identity.NewPostgres(pool),
		Scoped:     isolation.NewPostgres(pool),
		Sessions:   sessions,
		SCIMDir:    scim.NewPostgres(pool),
		ScimTokens: scim.NewWorkspacePostgres(pool),
		// A raw JSON logger with no redaction: the token must never reach
		// the log in the first place.
		Log:            slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		PlatformAdmins: []authz.PrincipalRef{{Issuer: owner.Issuer, Subject: owner.ExternalSubject}},
		SCIM: scim.Settings{
			BearerToken: scimTestToken,
			Issuer:      scimIssuer,
			DefaultRole: authz.RoleViewer,
		},
	}))
	return &scimWSHarness{t: t, ctx: ctx, h: h, app: pool, admin: adminPool, sessions: sessions, owner: owner, n: n, logs: logs}
}

func (th *scimWSHarness) uniq(prefix string) string {
	th.seq++
	return fmt.Sprintf("%s-%d-%d", prefix, th.n, th.seq)
}

func (th *scimWSHarness) workspace() scimWS {
	th.t.Helper()
	th.seq++
	slug := fmt.Sprintf("sw%d%d", th.n%1_000_000_000_000, th.seq)
	rec := httptest.NewRecorder()
	th.h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"`+slug+`","name":"SCIM"}`, th.owner))
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	var tenant identity.Tenant
	_ = json.Unmarshal(rec.Body.Bytes(), &tenant)
	rec = httptest.NewRecorder()
	th.h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"`+slug+`","workbench_key":"scimwb","name":"SCIM WB"}`, th.owner))
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

func (th *scimWSHarness) adminDo(w scimWS, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	if body == "" {
		th.h.ServeHTTP(rec, workspaceRequest(method, path, nil, th.owner, w.tenant, w.ws))
	} else {
		th.h.ServeHTTP(rec, workspaceJSON(method, path, []byte(body), th.owner, w.tenant, w.ws))
	}
	return rec
}

func (th *scimWSHarness) mint(w scimWS, name string) (id, token string) {
	th.t.Helper()
	rec := th.adminDo(w, http.MethodPost, "/api/v1/workspace/scim-tokens", `{"displayName":"`+name+`"}`)
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("mint: %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		th.t.Fatalf("mint Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	var body struct {
		ID, Token, Prefix, DisplayName string
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if !scim.WellFormedToken(body.Token) || body.Prefix != scim.TokenPrefix || body.DisplayName != name {
		th.t.Fatalf("mint body: %+v", body)
	}
	return body.ID, body.Token
}

func (th *scimWSHarness) scim(token, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	th.h.ServeHTTP(rec, scimRequest(method, path, body, token))
	return rec
}

type scimUserBody struct {
	ID          string `json:"id"`
	UserName    string `json:"userName"`
	DisplayName string `json:"displayName"`
	ExternalID  string `json:"externalId"`
	Active      bool   `json:"active"`
}

func decodeScimUser(t *testing.T, rec *httptest.ResponseRecorder) scimUserBody {
	t.Helper()
	var u scimUserBody
	if err := json.Unmarshal(rec.Body.Bytes(), &u); err != nil {
		t.Fatalf("decode user: %v %s", err, rec.Body.String())
	}
	return u
}

func (th *scimWSHarness) postUser(token, body string) scimUserBody {
	th.t.Helper()
	rec := th.scim(token, http.MethodPost, "/scim/v2/Users", body)
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("post user: %d %s", rec.Code, rec.Body.String())
	}
	return decodeScimUser(th.t, rec)
}

func (th *scimWSHarness) setActive(token, userID string, active bool, want int) scimUserBody {
	th.t.Helper()
	rec := th.scim(token, http.MethodPatch, "/scim/v2/Users/"+userID,
		fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":%t}]}`, active))
	if rec.Code != want {
		th.t.Fatalf("patch active=%t: %d %s", active, rec.Code, rec.Body.String())
	}
	if want != http.StatusOK {
		return scimUserBody{}
	}
	return decodeScimUser(th.t, rec)
}

func (th *scimWSHarness) roles(w scimWS, userID string) string {
	th.t.Helper()
	var out string
	if err := th.admin.QueryRow(th.ctx, `
		SELECT COALESCE(string_agg(r.key, ',' ORDER BY r.key), '')
		  FROM workspace_role_bindings b JOIN roles r ON r.id = b.role_id
		 WHERE b.workspace_id = $1::uuid AND b.user_id = $2::uuid`, w.ws.ID, userID).Scan(&out); err != nil {
		th.t.Fatal(err)
	}
	return out
}

func (th *scimWSHarness) groupRows(w scimWS, userID string) int {
	th.t.Helper()
	var n int
	if err := th.admin.QueryRow(th.ctx, `
		SELECT count(*) FROM workspace_group_members WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, w.ws.ID, userID).Scan(&n); err != nil {
		th.t.Fatal(err)
	}
	return n
}

func (th *scimWSHarness) status(userID string) string {
	th.t.Helper()
	var s string
	if err := th.admin.QueryRow(th.ctx, `SELECT status FROM users WHERE id = $1::uuid`, userID).Scan(&s); err != nil {
		th.t.Fatal(err)
	}
	return s
}

// link reports whether the link exists and whether it is deactivated.
func (th *scimWSHarness) link(w scimWS, userID string) (exists, deactivated bool) {
	th.t.Helper()
	var d *time.Time
	err := th.admin.QueryRow(th.ctx, `
		SELECT deactivated_at FROM scim_workspace_users WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, w.ws.ID, userID).Scan(&d)
	if err != nil {
		return false, false
	}
	return true, d != nil
}

func (th *scimWSHarness) addToGroup(w scimWS, userID string) {
	th.t.Helper()
	rec := th.adminDo(w, http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"`+th.uniq("grp")+`"}`)
	if rec.Code != http.StatusCreated {
		th.t.Fatalf("group: %d %s", rec.Code, rec.Body.String())
	}
	var g identity.Group
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	if rec := th.adminDo(w, http.MethodPost, "/api/v1/workspace/groups/"+g.ID+"/members", `{"userId":"`+userID+`"}`); rec.Code != http.StatusNoContent {
		th.t.Fatalf("group member: %d %s", rec.Code, rec.Body.String())
	}
}

func (th *scimWSHarness) session(userID string) string {
	th.t.Helper()
	issued, err := th.sessions.Create(th.ctx, userID, time.Now(), time.Hour, 8*time.Hour)
	if err != nil {
		th.t.Fatal(err)
	}
	return issued.Token
}

func (th *scimWSHarness) sessionAlive(token string) bool {
	_, err := th.sessions.Lookup(th.ctx, token, time.Now())
	return err == nil
}

func (th *scimWSHarness) auditCount(w scimWS, action, userID string) int {
	th.t.Helper()
	var n int
	if err := th.admin.QueryRow(th.ctx, `
		SELECT count(*) FROM audit_events
		 WHERE workspace_id = $1::uuid AND action = $2 AND ($3 = '' OR resource_id = $3::uuid)`,
		w.ws.ID, action, userID).Scan(&n); err != nil {
		th.t.Fatal(err)
	}
	return n
}

func scimUserJSON(userName, externalID, display string) string {
	return fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":%q,"externalId":%q,"displayName":%q,"active":true}`, userName, externalID, display)
}

func scimGroupPatch(op, userID string) string {
	return fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":%q,"path":"members","value":[{"value":%q}]}]}`, op, userID)
}

// Terry: isolation A/B. active:false and DELETE from A's token leave B's
// membership, sessions, roles, and groups intact.
func TestScimWorkspaceTokenIsolationAB(t *testing.T) {
	th := newScimWSHarness(t)
	a, b := th.workspace(), th.workspace()
	_, tokA := th.mint(a, "IdP A")
	_, tokB := th.mint(b, "IdP B")

	userName, ext := th.uniq("iso"), th.uniq("iso-ext")
	ua := th.postUser(tokA, scimUserJSON(userName, ext, "Iso User"))
	ub := th.postUser(tokB, scimUserJSON(userName, ext, "Iso User"))
	if ua.ID != ub.ID || !ua.Active || !ub.Active {
		t.Fatalf("same IdP subject must be one user: %+v %+v", ua, ub)
	}
	uid := ua.ID
	putMember(t, th.h, th.owner, b.tenant, b.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Iso User","role_keys":["approver","viewer"]}`, scimIssuer, ext))
	th.addToGroup(b, uid)
	sess := th.session(uid)

	assertB := func(step string) {
		t.Helper()
		if got := th.roles(b, uid); got != "approver,viewer" {
			t.Fatalf("%s: B roles = %q", step, got)
		}
		if th.groupRows(b, uid) != 1 {
			t.Fatalf("%s: B group rows changed", step)
		}
		if !th.sessionAlive(sess) {
			t.Fatalf("%s: session revoked", step)
		}
		if th.status(uid) != "active" {
			t.Fatalf("%s: user globally changed", step)
		}
		if exists, deact := th.link(b, uid); !exists || deact {
			t.Fatalf("%s: B link = %t %t", step, exists, deact)
		}
		rec := th.scim(tokB, http.MethodGet, "/scim/v2/Users/"+uid, "")
		if rec.Code != http.StatusOK || !decodeScimUser(t, rec).Active {
			t.Fatalf("%s: B view = %d %s", step, rec.Code, rec.Body.String())
		}
	}

	if got := th.setActive(tokA, uid, false, http.StatusOK); got.Active {
		t.Fatalf("A deactivate response active = true")
	}
	if got := th.roles(a, uid); got != "" {
		t.Fatalf("A roles after deactivate = %q", got)
	}
	if exists, deact := th.link(a, uid); !exists || !deact {
		t.Fatalf("A link after deactivate = %t %t", exists, deact)
	}
	assertB("after A active:false")

	if rec := th.scim(tokA, http.MethodDelete, "/scim/v2/Users/"+uid, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("A delete: %d %s", rec.Code, rec.Body.String())
	}
	if exists, _ := th.link(a, uid); exists {
		t.Fatal("A link survived DELETE")
	}
	if rec := th.scim(tokA, http.MethodGet, "/scim/v2/Users/"+uid, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("A get after delete = %d", rec.Code)
	}
	assertB("after A DELETE")
}

// Terry: ignored changes. name/userName edits and a global re-enable are
// ignored and audited; POST of a disabled user adds membership but the
// response stays active:false.
func TestScimWorkspaceTokenIgnoredChanges(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	_, tok := th.mint(a, "IdP")

	userName, ext := th.uniq("ign"), th.uniq("ign-ext")
	u := th.postUser(tok, scimUserJSON(userName, ext, "Ada"))
	put := fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":%q,"externalId":%q,"displayName":"Renamed","name":{"formatted":"Renamed"},"active":true}`, "renamed-"+userName, ext)
	rec := th.scim(tok, http.MethodPut, "/scim/v2/Users/"+u.ID, put)
	if rec.Code != http.StatusOK {
		t.Fatalf("put: %d %s", rec.Code, rec.Body.String())
	}
	got := decodeScimUser(t, rec)
	if got.UserName != userName || got.DisplayName != "Ada" || !got.Active {
		t.Fatalf("name edits must be ignored: %+v", got)
	}
	var dbName, linkName string
	if err := th.admin.QueryRow(th.ctx, `SELECT u.display_name, l.user_name FROM users u JOIN scim_workspace_users l ON l.user_id = u.id WHERE u.id = $1::uuid`, u.ID).Scan(&dbName, &linkName); err != nil {
		t.Fatal(err)
	}
	if dbName != "Ada" || linkName != userName {
		t.Fatalf("stored names changed: %q %q", dbName, linkName)
	}
	var attrs string
	if err := th.admin.QueryRow(th.ctx, `
		SELECT details_redacted->>'attributes' FROM audit_events
		 WHERE workspace_id = $1::uuid AND action = $2 AND resource_id = $3::uuid`, a.ws.ID, scim.AuditUserChangeIgnored, u.ID).Scan(&attrs); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(attrs, "userName") || !strings.Contains(attrs, "displayName") {
		t.Fatalf("ignored audit attributes = %s", attrs)
	}

	// Global re-enable is ignored.
	if _, err := th.admin.Exec(th.ctx, `UPDATE users SET status = 'disabled' WHERE id = $1::uuid`, u.ID); err != nil {
		t.Fatal(err)
	}
	if got := th.setActive(tok, u.ID, true, http.StatusOK); got.Active {
		t.Fatal("globally disabled user reported active")
	}
	if th.status(u.ID) != "disabled" {
		t.Fatal("workspace token re-enabled a user globally")
	}
	if th.auditCount(a, scim.AuditUserChangeIgnored, u.ID) != 2 {
		t.Fatal("ignored re-enable not audited")
	}

	// POST of a globally disabled user: membership added, active:false.
	dis := th.uniq("dis")
	var disID string
	if err := th.admin.QueryRow(th.ctx, `INSERT INTO users (issuer, external_subject, display_name, status) VALUES ($1, $2, 'Disabled', 'disabled') RETURNING id::text`, scimIssuer, dis).Scan(&disID); err != nil {
		t.Fatal(err)
	}
	posted := th.postUser(tok, scimUserJSON(dis, "", "Ignored Name"))
	if posted.ID != disID || posted.Active || posted.DisplayName != "Disabled" {
		t.Fatalf("disabled POST = %+v", posted)
	}
	if th.roles(a, disID) != authz.RoleViewer || th.status(disID) != "disabled" {
		t.Fatalf("disabled POST: roles %q status %q", th.roles(a, disID), th.status(disID))
	}
}

// Terry: deactivate then reactivate with the same token restores
// membership with the default role, by user PATCH and by Group PATCH.
func TestScimWorkspaceTokenReactivation(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	_, tok := th.mint(a, "IdP")
	u := th.postUser(tok, scimUserJSON(th.uniq("re"), "", "Re"))
	th.addToGroup(a, u.ID)

	th.setActive(tok, u.ID, false, http.StatusOK)
	if th.roles(a, u.ID) != "" || th.groupRows(a, u.ID) != 0 {
		t.Fatal("deactivate left membership behind")
	}
	if got := th.setActive(tok, u.ID, true, http.StatusOK); !got.Active {
		t.Fatalf("reactivated user = %+v", got)
	}
	if th.roles(a, u.ID) != authz.RoleViewer {
		t.Fatalf("reactivated roles = %q", th.roles(a, u.ID))
	}
	if _, deact := th.link(a, u.ID); deact {
		t.Fatal("deactivated_at not cleared")
	}

	// Group remove deactivates; group add reactivates.
	if rec := th.scim(tok, http.MethodPatch, "/scim/v2/Groups/"+a.ws.ID, scimGroupPatch("remove", u.ID)); rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), u.ID) {
		t.Fatalf("group remove: %d %s", rec.Code, rec.Body.String())
	}
	if _, deact := th.link(a, u.ID); !deact || th.roles(a, u.ID) != "" {
		t.Fatal("group remove did not deactivate")
	}
	if rec := th.scim(tok, http.MethodGet, "/scim/v2/Users/"+u.ID, ""); decodeScimUser(t, rec).Active {
		t.Fatal("group-removed user still active")
	}
	if rec := th.scim(tok, http.MethodPatch, "/scim/v2/Groups/"+a.ws.ID, scimGroupPatch("add", u.ID)); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), u.ID) {
		t.Fatalf("group add: %d %s", rec.Code, rec.Body.String())
	}
	if _, deact := th.link(a, u.ID); deact || th.roles(a, u.ID) != authz.RoleViewer {
		t.Fatal("group add did not reactivate")
	}
	if th.auditCount(a, scim.AuditUserDeactivate, u.ID) != 2 || th.auditCount(a, scim.AuditUserReactivate, u.ID) != 2 {
		t.Fatal("deactivate/reactivate not audited")
	}
}

// Terry: a globally disabled user who is reactivated gets membership back
// but stays active:false.
func TestScimWorkspaceTokenReactivateDisabledUserStaysInactive(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	_, tok := th.mint(a, "IdP")
	u := th.postUser(tok, scimUserJSON(th.uniq("dr"), "", "DR"))
	th.setActive(tok, u.ID, false, http.StatusOK)
	if _, err := th.admin.Exec(th.ctx, `UPDATE users SET status = 'disabled' WHERE id = $1::uuid`, u.ID); err != nil {
		t.Fatal(err)
	}
	if got := th.setActive(tok, u.ID, true, http.StatusOK); got.Active {
		t.Fatal("disabled user reported active")
	}
	if th.roles(a, u.ID) != authz.RoleViewer {
		t.Fatalf("membership not restored: %q", th.roles(a, u.ID))
	}
	if _, deact := th.link(a, u.ID); deact {
		t.Fatal("link still deactivated")
	}
	if th.status(u.ID) != "disabled" {
		t.Fatal("user re-enabled globally")
	}
}

// Terry: an existing member with a custom role who is POSTed keeps that
// role and gets no default role.
func TestScimWorkspaceTokenExistingMemberKeepsRole(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	_, tok := th.mint(a, "IdP")
	subject := th.uniq("keep")
	m := putMember(t, th.h, th.owner, a.tenant, a.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Keeper","role_keys":["approver"]}`, scimIssuer, subject))
	u := th.postUser(tok, scimUserJSON(subject, "", "Other Name"))
	if u.ID != m.User.ID || !u.Active || u.DisplayName != "Keeper" {
		t.Fatalf("POST existing member = %+v", u)
	}
	if got := th.roles(a, u.ID); got != authz.RoleApprover {
		t.Fatalf("roles = %q, want approver only", got)
	}
	rec := th.scim(tok, http.MethodGet, "/scim/v2/Groups/"+a.ws.ID, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), u.ID) {
		t.Fatalf("group view: %d %s", rec.Code, rec.Body.String())
	}
	// Re-POST of a linked user is a conflict and changes nothing.
	if rec := th.scim(tok, http.MethodPost, "/scim/v2/Users", scimUserJSON(subject, "", "Keeper")); rec.Code != http.StatusConflict {
		t.Fatalf("re-POST = %d", rec.Code)
	}
	if got := th.roles(a, u.ID); got != authz.RoleApprover {
		t.Fatalf("roles after re-POST = %q", got)
	}
}

// Terry: an admin who was never linked is invisible to the token and
// cannot be removed by it.
func TestScimWorkspaceTokenUnlinkedAdminInvisible(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	_, tok := th.mint(a, "IdP")
	linked := th.postUser(tok, scimUserJSON(th.uniq("lnk"), "", "Linked"))
	ownerID := th.owner.ID

	rec := th.scim(tok, http.MethodGet, "/scim/v2/Users", "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), ownerID) || !strings.Contains(rec.Body.String(), linked.ID) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	if rec := th.scim(tok, http.MethodGet, "/scim/v2/Users?filter="+urlQuery(`userName eq "`+th.owner.ExternalSubject+`"`), ""); !strings.Contains(rec.Body.String(), `"totalResults":0`) {
		t.Fatalf("filter found unlinked admin: %s", rec.Body.String())
	}
	for _, c := range []struct{ method, body string }{
		{http.MethodGet, ""},
		{http.MethodPatch, `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}`},
		{http.MethodPut, scimUserJSON("x", "", "x")},
		{http.MethodDelete, ""},
	} {
		if rec := th.scim(tok, c.method, "/scim/v2/Users/"+ownerID, c.body); rec.Code != http.StatusNotFound {
			t.Fatalf("%s unlinked admin = %d %s", c.method, rec.Code, rec.Body.String())
		}
	}
	rec = th.scim(tok, http.MethodGet, "/scim/v2/Groups/"+a.ws.ID, "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), ownerID) {
		t.Fatalf("group shows unlinked admin: %s", rec.Body.String())
	}
	if rec := th.scim(tok, http.MethodPatch, "/scim/v2/Groups/"+a.ws.ID, scimGroupPatch("remove", ownerID)); rec.Code != http.StatusOK {
		t.Fatalf("group remove unlinked = %d %s", rec.Code, rec.Body.String())
	}
	if rec := th.scim(tok, http.MethodPatch, "/scim/v2/Groups/"+a.ws.ID, scimGroupPatch("add", ownerID)); rec.Code != http.StatusBadRequest {
		t.Fatalf("group add unlinked = %d %s", rec.Code, rec.Body.String())
	}
	if got := th.roles(a, ownerID); got != authz.RoleAdmin {
		t.Fatalf("unlinked admin roles = %q", got)
	}
}

func urlQuery(s string) string {
	r := strings.NewReplacer(" ", "%20", `"`, "%22")
	return r.Replace(s)
}

// Terry: refusals. Revoked, inactive workspace, and inactive tenant are
// 401; A's token on B's users and group is 404.
func TestScimWorkspaceTokenRefusals(t *testing.T) {
	th := newScimWSHarness(t)
	a, b, c, d := th.workspace(), th.workspace(), th.workspace(), th.workspace()
	tokAID, tokA := th.mint(a, "A")
	_, tokB := th.mint(b, "B")
	_, tokC := th.mint(c, "C")
	_, tokD := th.mint(d, "D")

	for _, tok := range []string{tokA, tokB, tokC, tokD} {
		if rec := th.scim(tok, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusOK {
			t.Fatalf("fresh token = %d", rec.Code)
		}
	}
	if _, err := th.admin.Exec(th.ctx, `UPDATE workspaces SET status = 'disabled' WHERE id = $1::uuid`, c.ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := th.admin.Exec(th.ctx, `UPDATE tenants SET status = 'disabled' WHERE id = $1::uuid`, d.tenant.ID); err != nil {
		t.Fatal(err)
	}
	if rec := th.scim(tokC, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("inactive workspace = %d", rec.Code)
	}
	if rec := th.scim(tokD, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("inactive tenant = %d", rec.Code)
	}

	// A's token on B's users and group.
	bUser := th.postUser(tokB, scimUserJSON(th.uniq("bonly"), "", "B Only"))
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/scim/v2/Users/" + bUser.ID, ""},
		{http.MethodPut, "/scim/v2/Users/" + bUser.ID, scimUserJSON("x", "", "x")},
		{http.MethodPatch, "/scim/v2/Users/" + bUser.ID, `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}`},
		{http.MethodDelete, "/scim/v2/Users/" + bUser.ID, ""},
		{http.MethodGet, "/scim/v2/Groups/" + b.ws.ID, ""},
		{http.MethodPatch, "/scim/v2/Groups/" + b.ws.ID, scimGroupPatch("remove", bUser.ID)},
	} {
		if rec := th.scim(tokA, c.method, c.path, c.body); rec.Code != http.StatusNotFound {
			t.Fatalf("A on B %s %s = %d %s", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
	if rec := th.scim(tokA, http.MethodGet, "/scim/v2/Groups?filter="+urlQuery(`id eq "`+b.ws.ID+`"`), ""); !strings.Contains(rec.Body.String(), `"totalResults":0`) {
		t.Fatalf("A lists B's group: %s", rec.Body.String())
	}
	if rec := th.scim(tokA, http.MethodGet, "/scim/v2/Groups", ""); rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), b.ws.ID) || !strings.Contains(rec.Body.String(), a.ws.ID) {
		t.Fatalf("A group list: %s", rec.Body.String())
	}
	if th.roles(b, bUser.ID) != authz.RoleViewer {
		t.Fatal("A's token changed B")
	}

	// Revoked.
	if rec := th.adminDo(a, http.MethodDelete, "/api/v1/workspace/scim-tokens/"+tokAID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}
	if rec := th.scim(tokA, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked = %d", rec.Code)
	}
	// Unknown and malformed workspace-shaped bearers.
	fresh, err := scim.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	for _, tok := range []string{fresh, scim.TokenPrefix + "short", tokB + "x"} {
		if rec := th.scim(tok, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("bad workspace bearer = %d", rec.Code)
		}
	}
}

// Terry: rotation. Two tokens work, a third is refused, revoking one
// leaves the other working.
func TestScimTokenAdminRotation(t *testing.T) {
	th := newScimWSHarness(t)
	a, b := th.workspace(), th.workspace()
	id1, tok1 := th.mint(a, "Okta primary")
	_, tok2 := th.mint(a, "Okta rotation")
	bID, _ := th.mint(b, "B")
	for _, tok := range []string{tok1, tok2} {
		if rec := th.scim(tok, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusOK {
			t.Fatalf("token = %d", rec.Code)
		}
	}
	rec := th.adminDo(a, http.MethodPost, "/api/v1/workspace/scim-tokens", `{"displayName":"third"}`)
	assertProblem(t, rec, http.StatusConflict, CodeScimTokenLimit, "caller-request-16")

	rec = th.adminDo(a, http.MethodGet, "/api/v1/workspace/scim-tokens", "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), scim.TokenPrefix+"A") || strings.Contains(rec.Body.String(), tok1) || strings.Contains(rec.Body.String(), `"token"`) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var list struct {
		Items []struct {
			ID         string  `json:"id"`
			LastUsedAt *string `json:"lastUsedAt"`
			CreatedBy  *struct {
				ID string `json:"id"`
			} `json:"createdBy"`
		} `json:"items"`
		MaxActive  int  `json:"maxActive"`
		Configured bool `json:"configured"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list.Items) != 2 || list.MaxActive != 2 || !list.Configured {
		t.Fatalf("list body: %s", rec.Body.String())
	}
	for _, it := range list.Items {
		if it.LastUsedAt == nil || it.CreatedBy == nil || it.CreatedBy.ID != th.owner.ID {
			t.Fatalf("list item: %s", rec.Body.String())
		}
	}

	if rec := th.adminDo(a, http.MethodDelete, "/api/v1/workspace/scim-tokens/"+id1, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d", rec.Code)
	}
	if rec := th.scim(tok1, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked token = %d", rec.Code)
	}
	if rec := th.scim(tok2, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusOK {
		t.Fatalf("surviving token = %d", rec.Code)
	}
	// Revoking again is 204; another workspace's token id is 404.
	if rec := th.adminDo(a, http.MethodDelete, "/api/v1/workspace/scim-tokens/"+id1, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("re-revoke: %d", rec.Code)
	}
	assertProblem(t, th.adminDo(a, http.MethodDelete, "/api/v1/workspace/scim-tokens/"+bID, ""), http.StatusNotFound, CodeNotFound, "caller-request-16")
	// The freed slot can be used again.
	_, tok3 := th.mint(a, "Okta next")
	if rec := th.scim(tok3, http.MethodGet, "/scim/v2/Users", ""); rec.Code != http.StatusOK {
		t.Fatalf("new token = %d", rec.Code)
	}
	assertProblem(t, th.adminDo(a, http.MethodPost, "/api/v1/workspace/scim-tokens", `{"displayName":"  "}`), http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
}

// Terry: racing creates with one slot left give exactly two active
// tokens and one 409.
func TestScimTokenCreateRace(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	th.mint(a, "first")
	for round := 0; round < 5; round++ {
		var wg sync.WaitGroup
		codes := make([]int, 2)
		start := make(chan struct{})
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				codes[i] = th.adminDo(a, http.MethodPost, "/api/v1/workspace/scim-tokens", fmt.Sprintf(`{"displayName":"racer %d"}`, i)).Code
			}(i)
		}
		close(start)
		wg.Wait()
		created, limited := 0, 0
		for _, c := range codes {
			switch c {
			case http.StatusCreated:
				created++
			case http.StatusConflict:
				limited++
			}
		}
		var active int
		if err := th.admin.QueryRow(th.ctx, `SELECT count(*) FROM scim_tokens WHERE workspace_id = $1::uuid AND revoked_at IS NULL`, a.ws.ID).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if created != 1 || limited != 1 || active != 2 {
			t.Fatalf("round %d: codes %v active %d", round, codes, active)
		}
		// Free the slot the winner took for the next round.
		if _, err := th.admin.Exec(th.ctx, `
			UPDATE scim_tokens SET revoked_at = now()
			 WHERE workspace_id = $1::uuid AND revoked_at IS NULL AND display_name LIKE 'racer %'`, a.ws.ID); err != nil {
			t.Fatal(err)
		}
	}
	// The partial unique index is the backstop behind the lock.
	_, err := th.admin.Exec(th.ctx, `
		INSERT INTO scim_tokens (workspace_id, display_name, token_hash, slot)
		SELECT workspace_id, 'dup', repeat('a', 64), slot FROM scim_tokens
		 WHERE workspace_id = $1::uuid AND revoked_at IS NULL LIMIT 1`, a.ws.ID)
	if err == nil || !strings.Contains(err.Error(), "scim_tokens_active_slot_uidx") {
		t.Fatalf("duplicate active slot: %v", err)
	}
}

// Terry: the last-admin guard backstops every workspace-token removal,
// and a refused change rolls back the whole request.
func TestScimWorkspaceTokenLastAdminGuard(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	_, tok := th.mint(a, "IdP")
	subject := th.uniq("soleadmin")
	sole := th.postUser(tok, scimUserJSON(subject, "", "Sole Admin"))
	putMember(t, th.h, th.owner, a.tenant, a.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Sole Admin","role_keys":["admin"]}`, scimIssuer, subject))
	other := th.postUser(tok, scimUserJSON(th.uniq("other"), "", "Other"))
	th.setActive(tok, other.ID, false, http.StatusOK)
	if _, err := th.admin.Exec(th.ctx, `DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, a.ws.ID, th.owner.ID); err != nil {
		t.Fatal(err)
	}

	th.setActive(tok, sole.ID, false, http.StatusConflict)
	if rec := th.scim(tok, http.MethodDelete, "/scim/v2/Users/"+sole.ID, ""); rec.Code != http.StatusConflict {
		t.Fatalf("delete sole admin = %d", rec.Code)
	}
	body := fmt.Sprintf(`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"add","path":"members","value":[{"value":%q}]},{"op":"remove","path":"members","value":[{"value":%q}]}]}`, other.ID, sole.ID)
	if rec := th.scim(tok, http.MethodPatch, "/scim/v2/Groups/"+a.ws.ID, body); rec.Code != http.StatusConflict {
		t.Fatalf("group remove sole admin = %d %s", rec.Code, rec.Body.String())
	}
	if got := th.roles(a, sole.ID); got != authz.RoleAdmin {
		t.Fatalf("sole admin roles = %q", got)
	}
	if exists, deact := th.link(a, sole.ID); !exists || deact {
		t.Fatal("sole admin link changed")
	}
	if _, deact := th.link(a, other.ID); !deact || th.roles(a, other.ID) != "" {
		t.Fatal("refused group patch was not rolled back")
	}
}

// Terry: the instance bearer still disables globally and revokes
// sessions.
func TestScimInstanceTokenGlobalDisableUnchanged(t *testing.T) {
	th := newScimWSHarness(t)
	a, b := th.workspace(), th.workspace()
	_, tokA := th.mint(a, "A")
	ext := th.uniq("env-ext")
	rec := th.scim(scimTestToken, http.MethodPost, "/scim/v2/Users", scimUserJSON(th.uniq("env"), ext, "Env User"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("env post: %d %s", rec.Code, rec.Body.String())
	}
	u := decodeScimUser(t, rec)
	putMember(t, th.h, th.owner, b.tenant, b.ws, fmt.Sprintf(`{"issuer":%q,"external_subject":%q,"display_name":"Env User","role_keys":["viewer"]}`, scimIssuer, ext))
	linked := th.postUser(tokA, scimUserJSON(th.uniq("env-a"), ext, "Env User"))
	if linked.ID != u.ID {
		t.Fatal("workspace token resolved a different user")
	}
	sess := th.session(u.ID)
	if got := th.setActive(scimTestToken, u.ID, false, http.StatusOK); got.Active {
		t.Fatal("env disable reported active")
	}
	if th.status(u.ID) != "disabled" || th.sessionAlive(sess) {
		t.Fatal("env disable did not disable and revoke")
	}
	if th.roles(a, u.ID) != "" || th.roles(b, u.ID) != "" {
		t.Fatal("env disable left memberships")
	}
	if rec := th.scim(tokA, http.MethodGet, "/scim/v2/Users/"+u.ID, ""); rec.Code != http.StatusOK || decodeScimUser(t, rec).Active {
		t.Fatalf("workspace view after env disable: %s", rec.Body.String())
	}
}

// Terry: no audit row or log line contains a workspace token.
func TestScimTokenPlaintextNeverLoggedOrAudited(t *testing.T) {
	th := newScimWSHarness(t)
	a := th.workspace()
	id, tok := th.mint(a, "IdP")
	u := th.postUser(tok, scimUserJSON(th.uniq("plain"), "", "Plain"))
	th.setActive(tok, u.ID, false, http.StatusOK)
	th.setActive(tok, u.ID, true, http.StatusOK)
	th.scim(tok, http.MethodPut, "/scim/v2/Users/"+u.ID, scimUserJSON("renamed", "", "Renamed"))
	th.scim(tok, http.MethodDelete, "/scim/v2/Users/"+u.ID, "")
	th.scim(tok+"x", http.MethodGet, "/scim/v2/Users", "")
	th.adminDo(a, http.MethodDelete, "/api/v1/workspace/scim-tokens/"+id, "")
	th.scim(tok, http.MethodGet, "/scim/v2/Users", "")
	th.adminDo(a, http.MethodGet, "/api/v1/workspace/scim-tokens", "")

	if logs := th.logs.String(); !strings.Contains(logs, "/scim/v2/Users") {
		t.Fatal("request log was not captured; the check below would be vacuous")
	} else if strings.Contains(logs, scim.TokenPrefix) || strings.Contains(logs, tok[len(scim.TokenPrefix):]) {
		t.Fatal("log output contains a workspace token")
	}
	rows, err := th.admin.Query(th.ctx, `
		SELECT action, actor_id::text, host_context_redacted::text, details_redacted::text
		  FROM audit_events WHERE workspace_id = $1::uuid AND action LIKE 'scim%'`, a.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var action, host, details string
		var actor *string
		if err := rows.Scan(&action, &actor, &host, &details); err != nil {
			t.Fatal(err)
		}
		seen[action] = true
		all := action + host + details
		if strings.Contains(all, scim.TokenPrefix) || strings.Contains(all, tok[len(scim.TokenPrefix):]) {
			t.Fatalf("audit row %s contains a token", action)
		}
		switch action {
		case scim.AuditTokenCreate, scim.AuditTokenRevoke:
			if actor == nil || *actor != th.owner.ID {
				t.Fatalf("%s actor = %v", action, actor)
			}
		default:
			if actor != nil || !strings.Contains(details, id) {
				t.Fatalf("%s actor %v details %s", action, actor, details)
			}
		}
	}
	for _, want := range []string{scim.AuditTokenCreate, scim.AuditTokenRevoke, scim.AuditUserWorkspaceAdd, scim.AuditUserDeactivate, scim.AuditUserReactivate, scim.AuditUserChangeIgnored, scim.AuditUserWorkspaceRemove} {
		if !seen[want] {
			t.Fatalf("missing audit action %s (saw %v)", want, seen)
		}
	}
	var stored string
	if err := th.admin.QueryRow(th.ctx, `SELECT token_hash FROM scim_tokens WHERE id = $1::uuid`, id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != scim.HashToken(tok) || strings.Contains(stored, tok) {
		t.Fatal("stored token is not the hash")
	}
}
