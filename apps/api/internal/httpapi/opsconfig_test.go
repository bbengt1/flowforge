package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	ssheng "github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

func TestOpsConfigDraftPublishPinAndIsolation(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)
	cred := createKubernetesCredential(t, h, admin, tenant, wsA, "Cluster")
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
	sshCred := createSSHCredential(t, h, admin, tenant, ws, "BastionKey")

	cases := []struct {
		collection string
		name       string
		spec       map[string]any
	}{
		{"ssh-targets", "bastion", sshTargetSpec(sshCred.ID, "bastion.example.com")},
		{"command-profiles", "restart-unit", commandProfileSpec("systemctl restart unit", nil)},
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

func testKubeconfig() string {
	return "apiVersion: v1\nkind: Config\nclusters: []\nusers: []\n"
}

func createKubernetesCredential(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, name string) vault.Metadata {
	t.Helper()
	return createVaultCredential(t, h, user, tenant, ws, "kubernetes", name, map[string]string{"kubeconfig": testKubeconfig()})
}

func testSSHPrivateKey() string {
	return "-----BEGIN OPENSSH PRIVATE KEY-----\nunit-test-key\n-----END OPENSSH PRIVATE KEY-----\n"
}

func createSSHCredential(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, name string) vault.Metadata {
	t.Helper()
	return createVaultCredential(t, h, user, tenant, ws, "ssh_private_key", name, map[string]string{"privateKey": testSSHPrivateKey()})
}

func sshTargetSpec(credentialID, hostname string) map[string]any {
	return map[string]any{
		"credentialId":       credentialID,
		"hostname":           hostname,
		"port":               22,
		"hostKeyFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"allowedAddresses":   []string{"203.0.113.10"},
	}
}

func commandProfileSpec(template string, properties map[string]any) map[string]any {
	if properties == nil {
		properties = map[string]any{}
	}
	return map[string]any{
		"parameterSchema": map[string]any{"type": "object", "additionalProperties": false, "properties": properties},
		"template":        template,
		"retrySafe":       false,
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

func TestClusterTargetKubernetesPolicyHardening(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)
	kube := createKubernetesCredential(t, h, admin, tenant, wsA, "Kube")
	token := createVaultCredential(t, h, admin, tenant, wsA, "token", "Token", map[string]string{"token": "abcdefghijklmnop"})

	t.Run("wrong credential type is 400", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"name": "bad-type", "spec": clusterSpec(token.ID, "https://kube.example")})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/cluster-targets", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("cross-workspace credential is 404", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"k8s-b","name":"B"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("workspace B: %d %s", rec.Code, rec.Body.String())
		}
		var wsB identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(map[string]any{"name": "foreign-cred", "spec": clusterSpec(kube.ID, "https://kube.example")})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/cluster-targets", body, admin, tenant, wsB)
		req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})

	t.Run("empty allowlists are rejected", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"name": "empty-ns",
			"spec": map[string]any{
				"credentialId":      kube.ID,
				"endpoint":          map[string]any{"apiServer": "https://kube.example"},
				"allowedNamespaces": []string{},
			},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/cluster-targets", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")

		body, _ = json.Marshal(map[string]any{
			"name": "empty-policy",
			"spec": map[string]any{"kind": "kubernetes", "policy": map[string]any{"allowedNamespaces": []string{}}},
		})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/policies", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("publish kubernetes policy requires namespace allowlist", func(t *testing.T) {
		created := createOpsResource(t, h, admin, tenant, wsA, "policies", "incomplete-k8s", map[string]any{
			"kind":   "kubernetes",
			"policy": map[string]any{"requireApproval": true},
		})
		body, _ := json.Marshal(map[string]any{"revision": 1, "note": "no-ns"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/policies/"+created.Resource.ID+"/publish", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("allowedNamespaces must be a subset of bound policy", func(t *testing.T) {
		pol := createOpsResource(t, h, admin, tenant, wsA, "policies", "ns-gate", map[string]any{
			"kind":   "kubernetes",
			"policy": map[string]any{"allowedNamespaces": []string{"prod"}},
		})
		publishOps(t, h, admin, tenant, wsA, "policies", pol.Resource.ID, 1, "v1")
		body, _ := json.Marshal(map[string]any{
			"name": "overlap-fail",
			"spec": map[string]any{
				"credentialId":      kube.ID,
				"endpoint":          map[string]any{"apiServer": "https://kube.example"},
				"allowedNamespaces": []string{"staging"},
				"policyId":          pol.Resource.ID,
			},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/cluster-targets", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("responses never include kubeconfig", func(t *testing.T) {
		created := createOpsResource(t, h, admin, tenant, wsA, "cluster-targets", "safe-cluster", map[string]any{
			"credentialId": kube.ID,
			"endpoint":     map[string]any{"apiServer": "https://kube.example"},
			"serviceAccount": map[string]any{
				"name":         "flowforge-runner",
				"namespace":    "cp-ops-nprd",
				"roleTemplate": "namespace-scoped-runner",
			},
			"allowedNamespaces": []string{"cp-ops-nprd"},
		})
		raw := mustJSONObject(created)
		if strings.Contains(raw, "kubeconfig") || strings.Contains(raw, "apiVersion: v1") {
			t.Fatalf("kubeconfig leaked: %s", raw)
		}
		pub := publishOps(t, h, admin, tenant, wsA, "cluster-targets", created.Resource.ID, 1, "v1")
		pin := selectOps(t, h, admin, tenant, wsA, "cluster-targets", created.Resource.ID, "")
		if pin.VersionID != pub.Version.ID {
			t.Fatalf("pin = %+v", pin)
		}
		if sa, _ := pin.Spec["serviceAccount"].(map[string]any); sa == nil || sa["name"] != "flowforge-runner" {
			t.Fatalf("serviceAccount metadata missing: %+v", pin.Spec)
		}
	})

	t.Run("catalog documents engine rules", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/ops-config/catalog", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("ops catalog: %d %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"kubernetesEngine"`) || !strings.Contains(rec.Body.String(), kubernetes.CredentialType) {
			t.Fatalf("ops catalog missing engine: %s", rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/kubernetes/catalog", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("k8s catalog: %d %s", rec.Code, rec.Body.String())
		}
		var cat kubernetes.EngineCatalog
		if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
			t.Fatal(err)
		}
		if cat.CredentialType != kubernetes.CredentialType || cat.ClusterRoles || len(cat.AllowedKinds) == 0 {
			t.Fatalf("engine catalog = %+v", cat)
		}
		if len(cat.Nodes) < 4 || cat.Apply.FieldManager != kubernetes.FieldManager || cat.Apply.Force {
			t.Fatalf("e72 catalog = %+v", cat)
		}
		if cat.Apply.WaitReady != kubernetes.WaitReadyObserved || cat.Observation.Verb != "watch" {
			t.Fatalf("e73 observation = %+v", cat.Observation)
		}
	})
}

func TestSSHTargetAndCommandProfileHardening(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)
	sshKey := createSSHCredential(t, h, admin, tenant, wsA, "SSHKey")
	token := createVaultCredential(t, h, admin, tenant, wsA, "token", "Token", map[string]string{"token": "abcdefghijklmnop"})

	t.Run("wrong credential type is 400", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"name": "bad-type", "spec": sshTargetSpec(token.ID, "bastion.example.com")})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/ssh-targets", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("cross-workspace credential is 404", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"ssh-b","name":"B"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("workspace B: %d %s", rec.Code, rec.Body.String())
		}
		var wsB identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(map[string]any{"name": "foreign-cred", "spec": sshTargetSpec(sshKey.ID, "bastion.example.com")})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/ssh-targets", body, admin, tenant, wsB)
		req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})

	t.Run("tenancy denial and host identity", func(t *testing.T) {
		created := createOpsResource(t, h, admin, tenant, wsA, "ssh-targets", "tenancy-target", sshTargetSpec(sshKey.ID, "ops.example.com"))
		publishOps(t, h, admin, tenant, wsA, "ssh-targets", created.Resource.ID, 1, "v1")
		rec := httptest.NewRecorder()
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"ssh-c","name":"C"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("workspace C: %d %s", rec.Code, rec.Body.String())
		}
		var wsC identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &wsC); err != nil {
			t.Fatal(err)
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/ssh-targets/"+created.Resource.ID, nil, admin, tenant, wsC)
		req.Header.Set(headerWorkbenchKey, wsC.WorkbenchKey)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

		body := `{"name":"x","workspaceId":"33333333-3333-4333-8333-333333333333","spec":` + mustJSONObject(sshTargetSpec(sshKey.ID, "ops.example.com")) + `}`
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodPost, "/api/v1/ssh-targets", strings.NewReader(body), admin, tenant, wsA)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("empty allowlist and fingerprint are rejected", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"name": "empty-addrs",
			"spec": map[string]any{
				"credentialId": sshKey.ID, "hostname": "bastion.example.com",
				"hostKeyFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				"allowedAddresses":   []string{},
			},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/ssh-targets", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")

		body, _ = json.Marshal(map[string]any{
			"name": "bad-fp",
			"spec": map[string]any{
				"credentialId": sshKey.ID, "hostname": "bastion.example.com",
				"hostKeyFingerprint": "not-a-fingerprint",
			},
		})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/ssh-targets", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("parameter schema rejection", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"name": "interp",
			"spec": commandProfileSpec("echo $(whoami)", nil),
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/command-profiles", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")

		body, _ = json.Marshal(map[string]any{
			"name": "unknown-placeholder",
			"spec": commandProfileSpec("systemctl restart {unit}", nil),
		})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/command-profiles", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("publish immutability and pin behavior", func(t *testing.T) {
		target := createOpsResource(t, h, admin, tenant, wsA, "ssh-targets", "pin-target", sshTargetSpec(sshKey.ID, "pin.example.com"))
		pubTarget := publishOps(t, h, admin, tenant, wsA, "ssh-targets", target.Resource.ID, 1, "v1")
		profile := createOpsResource(t, h, admin, tenant, wsA, "command-profiles", "pin-profile", commandProfileSpec("uptime", nil))
		pubProfile := publishOps(t, h, admin, tenant, wsA, "command-profiles", profile.Resource.ID, 1, "v1")

		yamlDoc := sshWorkflowYAML("ssh-pin-restart", target.Resource.ID, profile.Resource.ID, nil)
		wf := createWorkflow(t, h, admin, tenant, wsA, yamlDoc)
		pubWF := publishWorkflow(t, h, admin, tenant, wsA, wf.Workflow.ID, wf.Draft.Revision, "pin ssh")
		if len(pubWF.Pins) != 2 {
			t.Fatalf("workflow pins = %+v", pubWF.Pins)
		}
		exec := startExecution(t, h, admin, tenant, wsA, wf.Workflow.ID, pubWF.Version.ID)

		saved, _ := json.Marshal(map[string]any{"revision": 1, "spec": commandProfileSpec("hostname", nil)})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/command-profiles/"+profile.Resource.ID+"/draft", saved, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save draft: %d %s", rec.Code, rec.Body.String())
		}
		next := publishOps(t, h, admin, tenant, wsA, "command-profiles", profile.Resource.ID, 2, "v2")
		if next.Version.VersionNumber != 2 || next.Version.Digest == pubProfile.Version.Digest {
			t.Fatalf("second publish = %+v", next)
		}
		later := selectOps(t, h, admin, tenant, wsA, "command-profiles", profile.Resource.ID, pubProfile.Version.ID)
		if later.Digest != pubProfile.Version.Digest || later.VersionID != pubProfile.Version.ID {
			t.Fatalf("pinned profile drifted: %+v", later)
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+wf.Workflow.ID+"/versions/"+pubWF.Version.ID+"/pins", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("version pins: %d %s", rec.Code, rec.Body.String())
		}
		var pinned listResponse[opsconfig.Pin]
		if err := json.Unmarshal(rec.Body.Bytes(), &pinned); err != nil {
			t.Fatal(err)
		}
		foundProfile := false
		for _, pin := range pinned.Items {
			if pin.Kind == opsconfig.KindCommandProfile && (pin.VersionID != pubProfile.Version.ID || pin.Digest != pubProfile.Version.Digest) {
				t.Fatalf("command profile pin drifted: %+v", pin)
			}
			if pin.Kind == opsconfig.KindSSHTarget && pin.VersionID != pubTarget.Version.ID {
				t.Fatalf("ssh target pin drifted: %+v", pin)
			}
			if pin.Kind == opsconfig.KindCommandProfile {
				foundProfile = true
			}
		}
		if !foundProfile {
			t.Fatalf("missing profile pin: %+v", pinned.Items)
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
		if len(got.Pins) != 2 {
			t.Fatalf("execution pins drifted: %+v", got.Pins)
		}
	})

	t.Run("workflow publish rejects parameters outside schema", func(t *testing.T) {
		target := createOpsResource(t, h, admin, tenant, wsA, "ssh-targets", "param-target", sshTargetSpec(sshKey.ID, "param.example.com"))
		publishOps(t, h, admin, tenant, wsA, "ssh-targets", target.Resource.ID, 1, "v1")
		profile := createOpsResource(t, h, admin, tenant, wsA, "command-profiles", "param-profile", commandProfileSpec("systemctl restart {unit}", map[string]any{
			"unit": map[string]any{"type": "string", "pattern": `[A-Za-z0-9._-]+`},
		}))
		publishOps(t, h, admin, tenant, wsA, "command-profiles", profile.Resource.ID, 1, "v1")
		yamlDoc := sshWorkflowYAML("ssh-param-restart", target.Resource.ID, profile.Resource.ID, map[string]any{"unit": "api; rm -rf /"})
		wf := createWorkflow(t, h, admin, tenant, wsA, yamlDoc)
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", []byte(`{"revision":1}`), admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("responses never include privateKey passphrase or kubeconfig", func(t *testing.T) {
		created := createOpsResource(t, h, admin, tenant, wsA, "ssh-targets", "safe-ssh", sshTargetSpec(sshKey.ID, "safe.example.com"))
		raw := mustJSONObject(created)
		for _, leak := range []string{"privateKey", "passphrase", "kubeconfig", "BEGIN OPENSSH", "unit-test-key"} {
			if strings.Contains(raw, leak) {
				t.Fatalf("%s leaked: %s", leak, raw)
			}
		}
		pub := publishOps(t, h, admin, tenant, wsA, "ssh-targets", created.Resource.ID, 1, "v1")
		pin := selectOps(t, h, admin, tenant, wsA, "ssh-targets", created.Resource.ID, "")
		if pin.VersionID != pub.Version.ID {
			t.Fatalf("pin = %+v", pin)
		}
		pinRaw := mustJSONObject(pin)
		if strings.Contains(pinRaw, "privateKey") || strings.Contains(pinRaw, "BEGIN") {
			t.Fatalf("pin leaked secret: %s", pinRaw)
		}
	})

	t.Run("catalog documents engine rules", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/ops-config/catalog", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("ops catalog: %d %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"sshEngine"`) || !strings.Contains(rec.Body.String(), ssheng.CredentialType) {
			t.Fatalf("ops catalog missing ssh engine: %s", rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/ssh/catalog", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("ssh catalog: %d %s", rec.Code, rec.Body.String())
		}
		var cat ssheng.EngineCatalog
		if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
			t.Fatal(err)
		}
		if cat.CredentialType != ssheng.CredentialType || cat.Render.RawShellInterpolation || cat.Retry.DefaultMaxAttempts != 0 {
			t.Fatalf("ssh catalog = %+v", cat)
		}
		if len(cat.ParameterTypes) == 0 || len(cat.Errors) == 0 {
			t.Fatalf("ssh catalog missing types/errors: %+v", cat)
		}
	})

	t.Run("rbac view edit publish", func(t *testing.T) {
		viewer := putMember(t, h, admin, tenant, wsA, `{"issuer":"https://idp.example","external_subject":"ssh-viewer","role_keys":["viewer"]}`)
		editor := putMember(t, h, admin, tenant, wsA, `{"issuer":"https://idp.example","external_subject":"ssh-editor","role_keys":["editor"]}`)
		if contains(viewer.Permissions, authz.PermOpsConfigEdit) || contains(viewer.Permissions, authz.PermSSHTargetUse) {
			t.Fatal("viewer must not edit ops config or use ssh targets")
		}
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/ssh-targets", mustJSONBytes(map[string]any{"name": "denied", "spec": sshTargetSpec(sshKey.ID, "deny.example.com")}), viewer.User, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

		created := createOpsResource(t, h, admin, tenant, wsA, "command-profiles", "rbac-profile", commandProfileSpec("true", nil))
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/command-profiles/"+created.Resource.ID+"/publish", []byte(`{}`), editor.User, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})
}

func sshWorkflowYAML(name, targetID, profileID string, params map[string]any) string {
	paramYAML := ""
	if params != nil {
		paramYAML = "\n        parameters:"
		for key, val := range params {
			s, _ := val.(string)
			paramYAML += "\n          " + key + ": " + strconv.Quote(s)
		}
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
    - id: restart
      type: ssh.run
      name: Restart
      with:
        sshTargetId: ` + targetID + `
        commandProfileId: ` + profileID + paramYAML + `
  edges: []
`
}
