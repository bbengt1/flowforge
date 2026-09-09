package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
)

func TestOpsConfigDraftPublishPinAndIsolation(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)
	cred := createVaultCredential(t, h, admin, tenant, wsA, "token", "Cluster", map[string]string{"token": "abcdefghijklmnop"})
	target := createPublishedClusterTarget(t, h, admin, tenant, wsA, cred.ID, "prod-cluster")

	if target.Resource.Status != opsconfig.StatusPublished || target.Version.VersionNumber != 1 {
		t.Fatalf("publish target: %+v", target)
	}

	t.Run("draft cannot be selected", func(t *testing.T) {
		draftOnly := createOpsResource(t, h, admin, tenant, wsA, "recipient-lists", "oncall", map[string]any{
			"recipientPolicy": map[string]any{"emails": []string{"ops@example.com"}},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/recipient-lists/"+draftOnly.Resource.ID+"/select", []byte(`{}`), admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	})

	t.Run("select returns exact published version", func(t *testing.T) {
		pin := selectOps(t, h, admin, tenant, wsA, "cluster-targets", target.Resource.ID, "")
		if pin.VersionID != target.Version.ID || pin.Digest != target.Version.Digest {
			t.Fatalf("pin = %+v want %s", pin, target.Version.ID)
		}
		saved, _ := json.Marshal(map[string]any{"revision": 1, "spec": clusterSpec(cred.ID, "https://kube.example/v2")})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/cluster-targets/"+target.Resource.ID+"/draft", saved, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save draft: %d %s", rec.Code, rec.Body.String())
		}
		later := selectOps(t, h, admin, tenant, wsA, "cluster-targets", target.Resource.ID, target.Version.ID)
		if later.Digest != target.Version.Digest || later.VersionID != target.Version.ID {
			t.Fatalf("pin drifted after draft edit: %+v", later)
		}
	})

	t.Run("workflow and execution pin stay stable", func(t *testing.T) {
		yamlDoc := workflowYAMLWithTarget(target.Resource.ID)
		wf := createWorkflow(t, h, admin, tenant, wsA, yamlDoc)
		pub := publishWorkflow(t, h, admin, tenant, wsA, wf.Workflow.ID, wf.Draft.Revision, "pin targets")
		if len(pub.Pins) != 1 || pub.Pins[0].VersionID != target.Version.ID {
			t.Fatalf("workflow pins = %+v", pub.Pins)
		}
		exec := startExecution(t, h, admin, tenant, wsA, wf.Workflow.ID, pub.Version.ID)

		next := publishOps(t, h, admin, tenant, wsA, "cluster-targets", target.Resource.ID, 2, "v2")
		if next.Version.VersionNumber != 2 {
			t.Fatalf("second publish = %+v", next)
		}

		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/workflows/"+wf.Workflow.ID+"/versions/"+pub.Version.ID+"/pins", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("version pins: %d %s", rec.Code, rec.Body.String())
		}
		var pinned listResponse[opsconfig.Pin]
		if err := json.Unmarshal(rec.Body.Bytes(), &pinned); err != nil {
			t.Fatal(err)
		}
		if len(pinned.Items) != 1 || pinned.Items[0].VersionID != target.Version.ID || pinned.Items[0].Digest != target.Version.Digest {
			t.Fatalf("version pin drifted: %+v", pinned.Items)
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+wf.Workflow.ID+"/executions/"+exec.ID, nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("exec: %d %s", rec.Code, rec.Body.String())
		}
		var got executionResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.WorkflowDigest != pub.Version.Digest || len(got.Pins) != 1 || got.Pins[0].VersionID != target.Version.ID {
			t.Fatalf("execution pin drifted: %+v", got)
		}
	})

	t.Run("cross-workspace denial", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"ops-b","name":"B"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("workspace B: %d %s", rec.Code, rec.Body.String())
		}
		var wsB identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
			t.Fatal(err)
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/cluster-targets/"+target.Resource.ID, nil, admin, tenant, wsB)
		req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/cluster-targets/"+target.Resource.ID+"/select", []byte(`{}`), admin, tenant, wsB)
		req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

		body := `{"name":"x","workspace_id":"33333333-3333-4333-8333-333333333333","spec":` + mustJSONObject(clusterSpec(cred.ID, "https://kube.example")) + `}`
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodPost, "/api/v1/cluster-targets", strings.NewReader(body), admin, tenant, wsA)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")

		foreignYAML := workflowYAMLWithTarget(target.Resource.ID)
		wfB := createWorkflow(t, h, admin, tenant, wsB, foreignYAML)
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wfB.Workflow.ID+"/publish", []byte(`{"revision":1}`), admin, tenant, wsB)
		req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})

	t.Run("rbac", func(t *testing.T) {
		viewer := putMember(t, h, admin, tenant, wsA, `{"issuer":"https://idp.example","external_subject":"ops-viewer","role_keys":["viewer"]}`)
		editor := putMember(t, h, admin, tenant, wsA, `{"issuer":"https://idp.example","external_subject":"ops-editor","role_keys":["editor"]}`)
		if contains(viewer.Permissions, authz.PermOpsConfigEdit) || contains(viewer.Permissions, authz.PermOpsConfigPublish) {
			t.Fatal("viewer must not edit or publish ops config")
		}
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/recipient-lists", []byte(`{"name":"denied","spec":{"recipientPolicy":{"emails":["a@example.com"]}}}`), viewer.User, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/cluster-targets/"+target.Resource.ID+"/publish", []byte(`{}`), editor.User, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})
}

func TestOpsConfigKindsPublishAndSelect(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	cred := createVaultCredential(t, h, admin, tenant, ws, "token", "API", map[string]string{"token": "abcdefghijklmnop"})

	cases := []struct {
		collection string
		name       string
		spec       map[string]any
	}{
		{"ssh-targets", "bastion", map[string]any{
			"credentialId": cred.ID, "hostname": "bastion.example.com", "port": 22,
			"hostKeyFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		}},
		{"command-profiles", "restart-unit", map[string]any{
			"parameterSchema": map[string]any{"type": "object"},
			"template":        "systemctl restart unit",
			"retrySafe":       false,
		}},
		{"runtime-profiles", "python-approved", map[string]any{
			"language":             "python",
			"imageDigest":          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"dependencyLockDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"limits":               map[string]any{"cpuMillis": 250, "memoryMib": 256, "timeoutSeconds": 30, "processes": 32},
		}},
		{"connections", "status-http", map[string]any{
			"type": "http", "credentialId": cred.ID,
			"endpointPolicy": map[string]any{"hosts": []string{"status.example.com"}, "methods": []string{"GET"}, "pathPrefixes": []string{"/v1/"}},
		}},
		{"recipient-lists", "ops-mail", map[string]any{
			"recipientPolicy": map[string]any{"domains": []string{"example.com"}},
		}},
		{"message-templates", "outage", map[string]any{
			"inputSchema":           map[string]any{"type": "object"},
			"contentClassification": "internal",
			"subject":               "Outage",
			"body":                  "Service is degraded.",
		}},
		{"response-schemas", "status-body", map[string]any{
			"schema":   map[string]any{"type": "object"},
			"maxBytes": 4096,
		}},
		{"policies", "k8s-prod", map[string]any{
			"kind":   "kubernetes",
			"policy": map[string]any{"namespaces": []string{"prod"}},
		}},
	}
	var refs []opsconfig.Ref
	for _, tc := range cases {
		created := createOpsResource(t, h, admin, tenant, ws, tc.collection, tc.name, tc.spec)
		pub := publishOps(t, h, admin, tenant, ws, tc.collection, created.Resource.ID, 1, "v1")
		pin := selectOps(t, h, admin, tenant, ws, tc.collection, created.Resource.ID, "")
		if pin.VersionID != pub.Version.ID {
			t.Fatalf("%s pin %s want %s", tc.collection, pin.VersionID, pub.Version.ID)
		}
		refs = append(refs, opsconfig.Ref{Kind: created.Resource.Kind, ResourceID: created.Resource.ID, VersionID: pub.Version.ID})
	}
	body, _ := json.Marshal(map[string]any{"refs": refs})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/ops-config/select", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch select: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[opsconfig.Pin]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != len(refs) {
		t.Fatalf("batch pins %d want %d", len(listed.Items), len(refs))
	}
}

func clusterSpec(credentialID, apiServer string) map[string]any {
	return map[string]any{
		"credentialId": credentialID,
		"endpoint":     map[string]any{"apiServer": apiServer},
	}
}

func createOpsResource(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, collection, name string, spec map[string]any) opsDetailResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": name, "spec": spec})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/"+collection, body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create %s: %d %s", collection, rec.Code, rec.Body.String())
	}
	var out opsDetailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func publishOps(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, collection, id string, revision int64, note string) opsPublishResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"revision": revision, "note": note})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/"+collection+"/"+id+"/publish", body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("publish %s: %d %s", collection, rec.Code, rec.Body.String())
	}
	var out opsPublishResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func selectOps(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, collection, id, versionID string) opsconfig.Pin {
	t.Helper()
	payload := map[string]any{}
	if versionID != "" {
		payload["versionId"] = versionID
	}
	body, _ := json.Marshal(payload)
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/"+collection+"/"+id+"/select", body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("select %s: %d %s", collection, rec.Code, rec.Body.String())
	}
	var pin opsconfig.Pin
	if err := json.Unmarshal(rec.Body.Bytes(), &pin); err != nil {
		t.Fatal(err)
	}
	return pin
}

func createPublishedClusterTarget(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, credentialID, name string) opsPublishResponse {
	t.Helper()
	created := createOpsResource(t, h, user, tenant, ws, "cluster-targets", name, clusterSpec(credentialID, "https://kube.example"))
	return publishOps(t, h, user, tenant, ws, "cluster-targets", created.Resource.ID, 1, "initial")
}

func workflowYAMLWithTarget(targetID string) string {
	return strings.ReplaceAll(validWorkflowYAML, "11111111-1111-4111-8111-111111111111", targetID)
}

func mustJSONObject(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestOpsCatalogRequiresView(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ops-config/catalog", nil))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestOpsConfigCredentialMustBeWorkspaceScoped(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	body, _ := json.Marshal(map[string]any{
		"name": "missing-cred",
		"spec": clusterSpec("11111111-1111-4111-8111-111111111111", "https://kube.example"),
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/cluster-targets", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
}
