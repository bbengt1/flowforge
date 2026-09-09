package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestArtifactUploadDownloadRetentionAndHold(t *testing.T) {
	var frozen atomic.Int64
	frozen.Store(time.Now().UTC().UnixNano())
	h, admin := seededWorkspaceWithClock(t, func() time.Time {
		return time.Unix(0, frozen.Load()).UTC()
	})
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e53")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
	detail := fetchExecutionDetail(t, h, admin, tenant, ws, exec.ID)
	if len(detail.Steps) == 0 {
		t.Fatal("expected a step")
	}
	stepID := detail.Steps[0].ID
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e53-viewer","role_keys":["viewer"]}`)

	t.Run("rejects unsafe content before upload", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"kind":                  "file",
			"filename":              "key.pem",
			"contentType":           "text/plain",
			"contentClassification": "internal",
			"content":               "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec.ID+"/steps/"+stepID+"/artifacts", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("rejects host-supplied storage locators", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"kind":        "log",
			"filename":    "out.log",
			"contentType": "text/plain",
			"content":     "hello",
			"storageRef":  "s3://bucket/key",
			"bucket":      "other-ws",
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec.ID+"/artifacts", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	upload, _ := json.Marshal(map[string]any{
		"kind":                  "log",
		"filename":              "../../secret.log",
		"contentType":           "text/plain",
		"contentClassification": "internal",
		"content":               "line-one\nAuthorization: Bearer abcdef.ghijk.lmnop\nline-three",
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec.ID+"/steps/"+stepID+"/logs", upload, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	var art wfstore.Artifact
	if err := json.Unmarshal(rec.Body.Bytes(), &art); err != nil {
		t.Fatal(err)
	}
	if art.Filename != "secret.log" || art.Kind != "log" || !art.Redacted {
		t.Fatalf("art = %+v", art)
	}
	if strings.Contains(rec.Body.String(), "storageRef") || strings.Contains(rec.Body.String(), "dekEnvelope") || strings.Contains(rec.Body.String(), "ciphertext") {
		t.Fatal("metadata leaked storage or envelope fields")
	}
	if strings.Contains(rec.Body.String(), "Bearer abcdef") {
		t.Fatal("log leaked token")
	}

	detail = fetchExecutionDetail(t, h, admin, tenant, ws, exec.ID)
	if len(detail.Artifacts) != 1 {
		t.Fatalf("detail artifacts = %+v", detail.Artifacts)
	}

	t.Run("viewer can list metadata and download after re-auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID+"/artifacts", nil, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID+"/steps/"+stepID+"/logs?limit=10", nil, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("logs: %d %s", rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "Bearer abcdef") {
			t.Fatal("bounded logs leaked token")
		}

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/artifacts/"+art.ID+"/downloads", []byte(`{}`), viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("grant: %d %s", rec.Code, rec.Body.String())
		}
		var grant downloadGrantResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &grant); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(grant.Download.Href, "/api/v1/artifact-downloads/") {
			t.Fatalf("href = %q", grant.Download.Href)
		}
		if strings.Contains(rec.Body.String(), "s3://") || strings.Contains(strings.ToLower(rec.Body.String()), "http://") {
			t.Fatal("returned a public or bucket URL")
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, grant.Download.Href, nil, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("download: %d %s", rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "Bearer abcdef") {
			t.Fatal("download leaked token")
		}
		if !strings.Contains(rec.Body.String(), "line-one") || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("body/headers = %q %q", rec.Body.String(), rec.Header().Get("Cache-Control"))
		}
	})

	t.Run("cross-workspace artifact is not-found", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedRequest(http.MethodPost, "/api/v1/workspaces", strings.NewReader(`{"tenant_slug":"acme","workbench_key":"e53-other","name":"Other"}`))
		req.Header.Set(headerIssuer, admin.Issuer)
		req.Header.Set(headerSubject, admin.ExternalSubject)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("other workspace: %d %s", rec.Code, rec.Body.String())
		}

		rec = httptest.NewRecorder()
		req = identifiedRequest(http.MethodGet, "/api/v1/artifacts/"+art.ID, nil)
		req.Header.Set(headerIssuer, admin.Issuer)
		req.Header.Set(headerSubject, admin.ExternalSubject)
		req.Header.Set(headerTenantSlug, "acme")
		req.Header.Set(headerWorkbenchKey, "e53-other")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

		rec = httptest.NewRecorder()
		req = identifiedRequest(http.MethodPost, "/api/v1/artifacts/"+art.ID+"/downloads", strings.NewReader(`{}`))
		req.Header.Set(headerIssuer, admin.Issuer)
		req.Header.Set(headerSubject, admin.ExternalSubject)
		req.Header.Set(headerTenantSlug, "acme")
		req.Header.Set(headerWorkbenchKey, "e53-other")
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})

	t.Run("viewer cannot place legal hold or purge", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/artifacts/"+art.ID+"/legal-hold", []byte(`{"hold":true,"reason":"case-1"}`), viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/retention/purge", []byte(`{}`), viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("legal hold preserves expired evidence with audit", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/artifacts/"+art.ID+"/legal-hold", []byte(`{"hold":true,"reason":"investigation-42"}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("hold: %d %s", rec.Code, rec.Body.String())
		}

		frozen.Store(time.Unix(0, frozen.Load()).Add(200 * 24 * time.Hour).UnixNano())
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/retention/purge", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("purge while held: %d %s", rec.Code, rec.Body.String())
		}
		var heldPurge retentionPurgeResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &heldPurge); err != nil {
			t.Fatal(err)
		}
		if heldPurge.Held < 1 || heldPurge.Purged != 0 {
			t.Fatalf("held purge = %+v", heldPurge)
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/artifacts/"+art.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("held artifact missing: %d %s", rec.Code, rec.Body.String())
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/audit-events?resourceType=artifact&resourceId="+art.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("audit: %d %s", rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		if !strings.Contains(body, "artifact.legal_hold.placed") || !strings.Contains(body, "artifact.retention.held") {
			t.Fatalf("missing hold audit trail: %s", body)
		}

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/artifacts/"+art.ID+"/legal-hold", []byte(`{"hold":false}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("release: %d %s", rec.Code, rec.Body.String())
		}

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/retention/purge", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("purge after release: %d %s", rec.Code, rec.Body.String())
		}
		var released retentionPurgeResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &released); err != nil {
			t.Fatal(err)
		}
		if released.Purged < 1 {
			t.Fatalf("released purge = %+v", released)
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/artifacts/"+art.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/artifacts/"+art.ID+"/downloads", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})
}

func fetchExecutionDetail(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, executionID string) executionResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/executions/"+executionID, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get execution: %d %s", rec.Code, rec.Body.String())
	}
	var out executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
