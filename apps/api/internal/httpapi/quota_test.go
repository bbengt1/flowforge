package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/quota"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestWorkspaceQuotaAllowDenyAndIsolation(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:     store,
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: wfstore.NewMemory(),
		Quota: quota.Limits{
			MutatePerMinute:    1,
			MutateBurst:        1,
			ReadPerMinute:      -1,
			ReadBurst:          -1,
			DownloadPerMinute:  -1,
			DownloadBurst:      -1,
			ExecutePerMinute:   -1,
			ExecuteBurst:       -1,
			ExecuteConcurrency: -1,
		},
	}))
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin))
	if rec.Code != http.StatusCreated {
		t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin))
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"other","name":"Other"}`, admin))
	if rec.Code != http.StatusCreated {
		t.Fatalf("second workspace: %d %s", rec.Code, rec.Body.String())
	}
	wsA, tenant := currentWorkspace(t, h, admin)
	other := workspaceByKey(t, store, "other")

	marker := "super-secret-token-value"
	raw, err := json.Marshal(map[string]string{
		"definitionYaml": strings.Replace(validWorkflowYAML, "restart-api-rollout", marker, 1),
	})
	if err != nil {
		t.Fatal(err)
	}
	body := raw

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, wsA))
	if rec.Code != http.StatusOK {
		t.Fatalf("first validate: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, wsA))
	assertProblem(t, rec, http.StatusTooManyRequests, CodeRateLimited, "caller-request-16")
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After")
	}
	if strings.Contains(rec.Body.String(), marker) {
		t.Fatal("429 must not echo the definition")
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, other))
	if rec.Code != http.StatusOK {
		t.Fatalf("other workspace must keep its own budget: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin-1","password":"not-the-password"}`))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
}

func TestWorkspaceQuotaStoreFailureFailsClosed(t *testing.T) {
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:      identity.NewMemory(),
		Scoped:     isolation.NewMemory(),
		Sessions:   session.NewMemory(),
		Workflows:  wfstore.NewMemory(),
		Quota:      quota.Limits{MutatePerMinute: 5, MutateBurst: 5},
		QuotaStore: downQuota{},
	}))
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin))
	if rec.Code != http.StatusCreated {
		t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin))
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	ws, tenant := currentWorkspace(t, h, admin)
	body := []byte(`{"definitionYaml":"apiVersion: flowforge/v1\n"}`)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, ws))
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
	if strings.Contains(rec.Body.String(), "definitionYaml") || strings.Contains(strings.ToLower(rec.Body.String()), "password") {
		t.Fatal("503 must not echo the request")
	}
}

type downQuota struct{}

func (downQuota) Take(context.Context, string, string, float64, float64, time.Time) (quota.Decision, error) {
	return quota.Decision{}, errors.New("rate store down")
}

func workspaceByKey(t *testing.T, store *identity.Memory, key string) identity.Workspace {
	t.Helper()
	ws, _, err := store.ResolveWorkspace(context.Background(), "", "acme", key)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}
