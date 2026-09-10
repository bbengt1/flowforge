package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

func TestLocalSeedListsWorkspaceAndCredentials(t *testing.T) {
	store := identity.NewMemory()
	keys := vault.TestKeys()
	vlt := vault.NewMemory(keys, nil)
	admins := []authz.PrincipalRef{{Issuer: httpTestIssuer, Subject: httpTestSubject}}
	res, err := localseed.Apply(t.Context(), localseed.Input{
		Store:          store,
		Vault:          vlt,
		Keys:           keys,
		PlatformAdmins: admins,
	})
	if err != nil {
		t.Fatal(err)
	}

	h := NewWithDeps(Deps{
		Store:          store,
		Vault:          vlt,
		Keys:           keys,
		Security:       Security{TrustIdentityHeaders: true, VaultKeys: keys},
		PlatformAdmins: admins,
	})

	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/workspaces", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list workspaces: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[identity.Membership]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || listed.Items[0].Workspace.WorkbenchKey != localseed.WorkbenchKey {
		t.Fatalf("workspaces %+v", listed.Items)
	}
	if listed.Items[0].Tenant.Slug != localseed.TenantSlug {
		t.Fatalf("tenant %+v", listed.Items[0].Tenant)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials", nil, res.Users[0], res.Tenant, res.Workspace)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list credentials: %d %s", rec.Code, rec.Body.String())
	}
	var creds listResponse[vault.Metadata]
	if err := json.Unmarshal(rec.Body.Bytes(), &creds); err != nil {
		t.Fatal(err)
	}
	if len(creds.Items) != 3 {
		t.Fatalf("credentials %+v", creds.Items)
	}
	for _, item := range creds.Items {
		if item.Fingerprint == "" {
			t.Fatalf("credential missing fingerprint: %+v", item)
		}
	}
}

func TestLocalSeedDoesNotWeakenFailClosedIdentity(t *testing.T) {
	store := identity.NewMemory()
	keys := vault.TestKeys()
	vlt := vault.NewMemory(keys, nil)
	admins := []authz.PrincipalRef{{Issuer: httpTestIssuer, Subject: httpTestSubject}}
	if _, err := localseed.Apply(t.Context(), localseed.Input{
		Store:          store,
		Vault:          vlt,
		Keys:           keys,
		PlatformAdmins: admins,
	}); err != nil {
		t.Fatal(err)
	}

	sessions := session.NewMemory()
	h := NewWithDeps(failClosedDeps(store, sessions, admins))

	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/workspaces", nil)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")

	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"other","name":"Other"}`, identity.User{
		Issuer: httpTestIssuer, ExternalSubject: httpTestSubject, DisplayName: "Admin",
	})
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")

	user, issued := issueTestSession(t, store, sessions, httpTestIssuer, httpTestSubject, "Admin")
	if user.ExternalSubject != httpTestSubject {
		t.Fatalf("session user %q", user.ExternalSubject)
	}
	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/workspaces", "", issued.Token, issued.CSRF)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("session list workspaces: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[identity.Membership]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 {
		t.Fatalf("seeded membership missing under session: %+v", listed.Items)
	}
}
