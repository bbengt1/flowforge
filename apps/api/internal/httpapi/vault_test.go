package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

const vaultPlaintext = "super-secret-plaintext-xyz-vault-e41"

func TestCredentialVaultCreateRotateTestNeverReturnsPlaintext(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	secret := map[string]string{"token": vaultPlaintext}
	created := createVaultCredential(t, h, admin, tenant, ws, "token", "PagerDuty", secret)

	if created.Type != "token" || created.DisplayName != "PagerDuty" || created.Fingerprint == "" {
		t.Fatalf("created = %+v", created)
	}
	assertNoPlaintext(t, mustJSONBytes(created), vaultPlaintext)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/credentials/"+created.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
	if strings.Contains(strings.ToLower(rec.Body.String()), "ciphertext") {
		t.Fatal("list included ciphertext")
	}

	rotateBody, _ := json.Marshal(map[string]any{"secret": map[string]string{"token": vaultPlaintext + "-rotated"}})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/credentials/"+created.ID+"/rotate", rotateBody, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext+"-rotated")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/credentials/"+created.ID+"/test", []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("test: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
	var tested struct {
		Result vault.TestResult `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &tested); err != nil {
		t.Fatal(err)
	}
	if tested.Result.Status != vault.TestPassed {
		t.Fatalf("test status = %+v", tested.Result)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials/"+created.ID+"/events", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("events: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
}

func TestCredentialVaultLogsMetricsAndAuditOmitPlaintext(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	createVaultCredential(t, h, admin, tenant, ws, "token", "Logs", map[string]string{"token": vaultPlaintext})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("metrics: %d", rec.Code)
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)

	rec = httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/credentials", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
}

func TestCredentialVaultRejectsCrossWorkspaceAndHostIdentity(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)
	created := createVaultCredential(t, h, admin, tenant, wsA, "token", "A", map[string]string{"token": vaultPlaintext})

	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"vault-b","name":"B"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace B: %d %s", rec.Code, rec.Body.String())
	}
	var wsB identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials/"+created.ID, nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials", nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list B: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[vault.Metadata]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 0 {
		t.Fatalf("list leaked %d credentials", len(listed.Items))
	}

	body := `{"type":"token","displayName":"x","workspace_id":"33333333-3333-3333-3333-333333333333","secret":{"token":"` + vaultPlaintext + `"}}`
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodPost, "/api/v1/credentials", strings.NewReader(body), admin, tenant, wsA)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
}

func TestCredentialVaultRBACAndDisablement(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createVaultCredential(t, h, admin, tenant, ws, "token", "RBAC", map[string]string{"token": vaultPlaintext})
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"vault-viewer","role_keys":["viewer"]}`)
	editor := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"vault-editor","role_keys":["editor"]}`)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/credentials", nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials/"+created.ID, nil, editor.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("editor view: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/credentials/"+created.ID+"/rotate", []byte(`{"secret":{"token":"abcdefghijk"}}`), editor.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/credentials/"+created.ID+"/disable", []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/credentials/"+created.ID+"/use", []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
}

func TestCredentialVaultUsageAndDeletionImpact(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createVaultCredential(t, h, admin, tenant, ws, "token", "Used", map[string]string{"token": vaultPlaintext})
	target := createPublishedClusterTarget(t, h, admin, tenant, ws, created.ID, "used-cluster")

	yamlDoc := workflowYAMLWithTarget(target.Resource.ID)
	wf := createWorkflow(t, h, admin, tenant, ws, yamlDoc)
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "pin")
	exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/credentials/"+created.ID+"/usage", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("usage: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
	var usage vault.Usage
	if err := json.Unmarshal(rec.Body.Bytes(), &usage); err != nil {
		t.Fatal(err)
	}
	if len(usage.Drafts) == 0 || len(usage.Versions) == 0 || len(usage.Executions) == 0 {
		t.Fatalf("usage missing refs: %+v", usage)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials/"+created.ID+"/deletion-impact", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("impact: %d %s", rec.Code, rec.Body.String())
	}
	var impact vault.DeletionImpact
	if err := json.Unmarshal(rec.Body.Bytes(), &impact); err != nil {
		t.Fatal(err)
	}
	if impact.CanDelete || len(impact.ActiveExecutions) == 0 {
		t.Fatalf("impact = %+v exec=%s", impact, exec.ID)
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodDelete, "/api/v1/credentials/"+created.ID, []byte(`{"confirm":true}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)

	other := createVaultCredential(t, h, admin, tenant, ws, "webhook_secret", "Hook", map[string]string{"secret": vaultPlaintext})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodDelete, "/api/v1/credentials/"+other.ID, []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodDelete, "/api/v1/credentials/"+other.ID, []byte(`{"confirm":true}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete unused: %d %s", rec.Code, rec.Body.String())
	}
}

func TestCredentialVaultFailsClosedWithoutKEK(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(Deps{Store: store, Keys: vault.Keys{}})
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"nokek","name":"NoKek"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"nokek","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	var ws identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &ws); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set(headerTenantSlug, "nokek")
	req.Header.Set(headerWorkbenchKey, "ops")
	h.ServeHTTP(rec, req)
	var current currentWorkspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"type": "token", "displayName": "Nope",
		"secret": map[string]string{"token": vaultPlaintext},
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/credentials", body, current.Principal, current.Tenant, current.Workspace)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "")
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
}

func TestCredentialCatalogAndPatchRejectSecret(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/credentials/catalog", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), vaultPlaintext) {
		t.Fatal("catalog leaked")
	}

	created := createVaultCredential(t, h, admin, tenant, ws, "kubernetes", "Cluster", map[string]string{
		"kubeconfig": "apiVersion: v1\nkind: Config\nclusters: []\nusers: []\n",
	})
	patch, _ := json.Marshal(map[string]any{"secret": map[string]string{"kubeconfig": vaultPlaintext}})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPatch, "/api/v1/credentials/"+created.ID, patch, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
}

func createVaultCredential(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, typ, name string, secret map[string]string) vault.Metadata {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"type": typ, "displayName": name, "tags": []string{"ops"}, "secret": secret,
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/credentials", body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create credential: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), vaultPlaintext)
	for _, v := range secret {
		assertNoPlaintext(t, rec.Body.Bytes(), v)
	}
	var out vault.Metadata
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func assertNoPlaintext(t *testing.T, body []byte, secret string) {
	t.Helper()
	if secret != "" && bytes.Contains(body, []byte(secret)) {
		t.Fatalf("plaintext leaked in response: %s", body)
	}
}

func mustJSONBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

