package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

// TestScimTokenAdminContractDoor pins the door on the SCIM workspace
// token admin routes: workspace.administer is required, a non-UUID token
// id is 404 after the door, and without a Postgres token store the
// routes are 503 rather than a partial answer.
func TestScimTokenAdminContractDoor(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"scim-token-viewer","display_name":"Viewer","role_keys":["viewer"]}`).User

	do := func(user identity.User, method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		if body == "" {
			h.ServeHTTP(rec, workspaceRequest(method, path, nil, user, tenant, ws))
		} else {
			h.ServeHTTP(rec, workspaceJSON(method, path, []byte(body), user, tenant, ws))
		}
		return rec
	}
	const base = "/api/v1/workspace/scim-tokens"
	tokenPath := base + "/6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b"
	cases := []struct {
		method, path, body string
	}{
		{http.MethodGet, base, ""},
		{http.MethodPost, base, `{"displayName":"Okta"}`},
		{http.MethodDelete, tokenPath, ""},
	}
	for _, c := range cases {
		name := fmt.Sprintf("%s %s", c.method, c.path)
		assertProblem(t, do(viewer, c.method, c.path, c.body), http.StatusForbidden, CodeForbidden, "caller-request-16")
		if rec := do(admin, c.method, c.path, c.body); rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), CodeDependencyUnavailable) {
			t.Fatalf("%s admin = %d %s", name, rec.Code, rec.Body.String())
		}
	}
	assertProblem(t, do(admin, http.MethodDelete, base+"/not-a-uuid", ""), http.StatusNotFound, CodeNotFound, "caller-request-16")
}

// TestScimWorkspaceBearerNeverMatchesInstanceToken: a bearer with the
// workspace token prefix only goes to the token store, even when it is
// byte-equal to the configured instance bearer. With no store it is 503,
// never an instance-wide 200.
func TestScimWorkspaceBearerNeverMatchesInstanceToken(t *testing.T) {
	shaped, err := scim.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	store := identity.NewMemory()
	d := scimDeps(store, session.NewMemory())
	d.SCIM.BearerToken = shaped
	h := NewWithDeps(d)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, scimRequest(http.MethodGet, "/scim/v2/Users", "", shaped))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("workspace-shaped instance bearer = %d %s", rec.Code, rec.Body.String())
	}

	// Issuer-only config: workspace tokens are on, the instance bearer is
	// off, and any other bearer is 401 (not 503).
	d = scimDeps(store, session.NewMemory())
	d.SCIM = scim.Settings{Issuer: scimIssuer, DefaultRole: authz.RoleViewer}
	h = NewWithDeps(d)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, scimRequest(http.MethodGet, "/scim/v2/Users", "", scimTestToken))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("instance bearer with issuer-only config = %d", rec.Code)
	}
}
