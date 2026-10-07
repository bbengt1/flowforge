package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

// TestScimTokenAdminContractDoor pins the door the SCIM workspace token
// admin routes run before the store lands: workspace.administer is
// required, and a non-UUID token id is 404 after the door.
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
		if rec := do(admin, c.method, c.path, c.body); rec.Code != http.StatusNotImplemented {
			t.Fatalf("%s admin = %d %s", name, rec.Code, rec.Body.String())
		}
	}
	assertProblem(t, do(admin, http.MethodDelete, base+"/not-a-uuid", ""), http.StatusNotFound, CodeNotFound, "caller-request-16")
}
