package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func pythonRuntimeSpec() map[string]any {
	return map[string]any{
		"language":             "python",
		"imageDigest":          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"dependencyLockDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"limits":               map[string]any{"cpuMillis": 250, "memoryMib": 256, "timeoutSeconds": 30, "processes": 32},
	}
}

func createPublishedRuntimeProfile(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, name string) (resourceID string) {
	t.Helper()
	created := createOpsResource(t, h, user, tenant, ws, "runtime-profiles", name, pythonRuntimeSpec())
	pub := publishOps(t, h, user, tenant, ws, "runtime-profiles", created.Resource.ID, 1, "approved")
	return pub.Resource.ID
}

func scriptWorkflowYAML(profileID string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: summarize-script
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: summarize
      type: script.python
      name: Summarize
      with:
        source: |
          import json
          print(json.dumps({"status": "complete"}))
        entrypoint: main.py
        runtimeProfileId: ` + profileID + `
        timeoutSeconds: 30
        memoryMiB: 128
  edges: []
`
}

func TestScriptCatalogPublishPinAndIsolation(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	profileID := createPublishedRuntimeProfile(t, h, admin, tenant, ws, "python-approved")

	t.Run("catalog documents publish rules", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/scripts/catalog", nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("catalog: %d %s", rec.Code, rec.Body.String())
		}
		var cat scripts.EngineCatalog
		if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
			t.Fatal(err)
		}
		if !cat.PublishRules.MutableArtifactsRejected || !cat.PublishRules.SecretsForbiddenInYAML {
			t.Fatalf("publish rules = %+v", cat.PublishRules)
		}
		if len(cat.Nodes) != 2 || len(cat.Errors) == 0 {
			t.Fatalf("catalog nodes/errors = %+v", cat)
		}
		if !cat.Isolation.NonRoot || cat.Isolation.UID != scripts.RunnerUID || !cat.Isolation.DefaultDenyEgress {
			t.Fatalf("isolation = %+v", cat.Isolation)
		}
		if cat.Isolation.RuntimePackageInstall || cat.Isolation.AllowPrivilegeEscalation {
			t.Fatal("package install and privilege escalation must be denied")
		}
		if cat.IO.MaxInputBytes == 0 || cat.IO.PlaintextCredentials || cat.Retry.BlindRetry || cat.Retry.DefaultMaxAttempts != 0 {
			t.Fatalf("io/retry = %+v %+v", cat.IO, cat.Retry)
		}
	})

	t.Run("dedicated publish scan sign pin", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"language":         "python",
			"source":           "import json\nprint(json.dumps({\"ok\": True}))\n",
			"entrypoint":       "main.py",
			"runtimeProfileId": profileID,
			"timeoutSeconds":   30,
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/scripts", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("publish script: %d %s", rec.Code, rec.Body.String())
		}
		var art scripts.Artifact
		if err := json.Unmarshal(rec.Body.Bytes(), &art); err != nil {
			t.Fatal(err)
		}
		if art.Digest == "" || art.ScanStatus != scripts.ScanClean || !strings.HasPrefix(art.Signature, scripts.SignaturePrefix) {
			t.Fatalf("artifact = %+v", art)
		}
		if strings.Contains(rec.Body.String(), "package") && strings.Contains(rec.Body.String(), "import json") {
			t.Fatal("response leaked package blob")
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/scripts/"+art.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("get script: %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("secret source rejected", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"language":         "python",
			"source":           "token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"\n",
			"entrypoint":       "main.py",
			"runtimeProfileId": profileID,
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/scripts", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
		if !strings.Contains(rec.Body.String(), "Secret") {
			t.Fatalf("detail = %s", rec.Body.String())
		}
	})

	t.Run("invalid entrypoint rejected", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"language":         "python",
			"source":           "print('ok')\n",
			"entrypoint":       "../main.py",
			"runtimeProfileId": profileID,
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/scripts", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("workflow publish pins script artifact", func(t *testing.T) {
		created := createWorkflow(t, h, admin, tenant, ws, scriptWorkflowYAML(profileID))
		pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "scripts")
		if len(pub.ScriptArtifacts) != 1 || pub.ScriptArtifacts[0].NodeID != "summarize" {
			t.Fatalf("script pins = %+v", pub.ScriptArtifacts)
		}
		if pub.ScriptArtifacts[0].ScanStatus != scripts.ScanClean {
			t.Fatalf("scan = %s", pub.ScriptArtifacts[0].ScanStatus)
		}

		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/versions/"+pub.Version.ID+"/script-artifacts", nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("list pins: %d %s", rec.Code, rec.Body.String())
		}

		exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
		if exec.WorkflowVersionID != pub.Version.ID {
			t.Fatalf("exec = %+v", exec)
		}
	})

	t.Run("cross-workspace artifact is 404", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"language":         "python",
			"source":           "print('tenant-a')\n",
			"entrypoint":       "main.py",
			"runtimeProfileId": profileID,
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/scripts", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
		}
		var art scripts.Artifact
		if err := json.Unmarshal(rec.Body.Bytes(), &art); err != nil {
			t.Fatal(err)
		}

		rec = httptest.NewRecorder()
		req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"other","name":"Other"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create other workspace: %d %s", rec.Code, rec.Body.String())
		}
		var other identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &other); err != nil {
			t.Fatal(err)
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/scripts/"+art.ID, nil, admin, tenant, other)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})
}

func TestScriptMutableArtifactRejectedAtExecute(t *testing.T) {
	mem := scripts.NewMemory()
	key := scripts.NewSigningKey()
	h, admin := seededWorkspaceWithScripts(t, mem, key)
	ws, tenant := currentWorkspace(t, h, admin)
	profileID := createPublishedRuntimeProfile(t, h, admin, tenant, ws, "python-exec")
	created := createWorkflow(t, h, admin, tenant, ws, scriptWorkflowYAML(profileID))
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "v1")
	if len(pub.ScriptArtifacts) != 1 {
		t.Fatalf("pins = %+v", pub.ScriptArtifacts)
	}

	t.Run("draft status", func(t *testing.T) {
		mem.Corrupt(pub.ScriptArtifacts[0].ArtifactID, func(a *scripts.Artifact) {
			a.Status = scripts.StatusDraft
		})
		rec := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{"workflowVersionId": pub.Version.ID})
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeArtifactMutable, "")
	})

	t.Run("pending scan", func(t *testing.T) {
		mem.Corrupt(pub.ScriptArtifacts[0].ArtifactID, func(a *scripts.Artifact) {
			a.Status = scripts.StatusPublished
			a.ScanStatus = scripts.ScanPending
		})
		rec := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{"workflowVersionId": pub.Version.ID})
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeArtifactUnscanned, "")
	})

	t.Run("unsigned", func(t *testing.T) {
		mem.Corrupt(pub.ScriptArtifacts[0].ArtifactID, func(a *scripts.Artifact) {
			a.Status = scripts.StatusPublished
			a.ScanStatus = scripts.ScanClean
			a.Signature = ""
		})
		rec := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{"workflowVersionId": pub.Version.ID})
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeArtifactUnsigned, "")
	})

	t.Run("failed scan", func(t *testing.T) {
		mem.Corrupt(pub.ScriptArtifacts[0].ArtifactID, func(a *scripts.Artifact) {
			a.Status = scripts.StatusPublished
			a.ScanStatus = scripts.ScanFailed
			a.Signature = pub.ScriptArtifacts[0].Signature
		})
		rec := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{"workflowVersionId": pub.Version.ID})
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeArtifactScanFailed, "")
	})
}

func seededWorkspaceWithScripts(t *testing.T, store scripts.Store, key []byte) (http.Handler, identity.User) {
	t.Helper()
	idStore := identity.NewMemory()
	keys := vault.TestKeys()
	workflows := wfstore.NewMemory()
	ops := opsconfig.NewMemory()
	h := NewWithDeps(Deps{
		Store:            idStore,
		Scoped:           isolation.NewMemory(),
		Sessions:         session.NewMemory(),
		Workflows:        workflows,
		Ops:              ops,
		Vault:            vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops}),
		Keys:             keys,
		Scripts:          store,
		ScriptSigningKey: key,
	})
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}

	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("current workspace: %d %s", rec.Code, rec.Body.String())
	}
	var current currentWorkspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	return h, current.Principal
}

func TestScriptDraftExecuteRejected(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	profileID := createPublishedRuntimeProfile(t, h, admin, tenant, ws, "python-draft-run")
	created := createWorkflow(t, h, admin, tenant, ws, scriptWorkflowYAML(profileID))
	if created.Workflow.Status != wfstore.StatusDraft {
		t.Fatalf("status = %s", created.Workflow.Status)
	}
	body, _ := json.Marshal(map[string]any{"draft": true})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
}
