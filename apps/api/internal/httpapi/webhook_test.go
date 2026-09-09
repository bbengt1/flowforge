package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const webhookSecretPlain = "super-secret-webhook-e102-value"
const typedWebhookYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e10-webhook
spec:
  triggers:
    - id: hook
      type: webhook
      inputSchema:
        type: object
        additionalProperties: false
        required: [env]
        properties:
          env:
            type: string
            enum: [prod, staging]
      contentType: application/json
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`

func TestWebhookTriggerCRUDRotateAndTenancy(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, typedWebhookYAML)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e102-viewer","role_keys":["viewer"]}`)
	cred := createVaultCredential(t, h, admin, tenant, ws, "webhook_secret", "Hook", map[string]string{"secret": webhookSecretPlain})

	t.Run("viewer cannot create", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowVersionId":  "00000000-0000-4000-8000-000000000001",
			"secretCredentialId": cred.ID,
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/triggers", body, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e10-hook")
	body, _ := json.Marshal(map[string]any{
		"type":               "webhook",
		"workflowVersionId":  pub.Version.ID,
		"secretCredentialId": cred.ID,
		"fieldMapping":       map[string]string{"env": "environment"},
		"rateLimitPerMinute": 2,
		"maxConcurrency":     2,
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/triggers", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create trigger: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain)
	var trig webhook.Trigger
	if err := json.Unmarshal(rec.Body.Bytes(), &trig); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(trig.PublicID, "wh_") || trig.IngressPath != "/api/v1/hooks/"+trig.PublicID {
		t.Fatalf("opaque id = %+v", trig)
	}
	if trig.SecretCredentialID != cred.ID || strings.Contains(rec.Body.String(), "secret") && strings.Contains(rec.Body.String(), webhookSecretPlain) {
		t.Fatalf("secret leaked or missing ref: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/triggers/"+trig.ID+"/rotate", mustJSONBytes(map[string]any{
		"secret": map[string]string{"secret": webhookSecretPlain + "-rotated"},
	}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain)
	assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain+"-rotated")

	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"e102-b","name":"B"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("other ws: %d %s", rec.Code, rec.Body.String())
	}
	var other identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &other); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/triggers/"+trig.ID, nil, admin, tenant, other)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/credentials/"+cred.ID+"/deletion-impact", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("impact: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain)
	if !strings.Contains(rec.Body.String(), `"triggers"`) || !strings.Contains(rec.Body.String(), `"canDelete":false`) {
		t.Fatalf("expected trigger block: %s", rec.Body.String())
	}
}

func TestWebhookIngressValidAndFailClosed(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	h, admin := seededWorkspaceWithClock(t, func() time.Time { return now })
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, typedWebhookYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e10-run")
	cred := createVaultCredential(t, h, admin, tenant, ws, "webhook_secret", "Hook", map[string]string{"secret": webhookSecretPlain})
	trig := createWebhookTrigger(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID, cred.ID, map[string]any{
		"fieldMapping":       map[string]string{"env": "environment"},
		"rateLimitPerMinute": 2,
		"maxBodyBytes":       256,
	})

	body := []byte(`{"environment":"prod","extra":"ignored"}`)
	ts := strconv.FormatInt(now.Unix(), 10)
	sig := webhook.SignV1([]byte(webhookSecretPlain), ts, body)

	t.Run("bad signature", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := signedHook(trig.PublicID, ts, "v1="+strings.Repeat("ab", 32), body)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
		assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain)
	})

	t.Run("timestamp skew", func(t *testing.T) {
		old := strconv.FormatInt(now.Add(-20*time.Minute).Unix(), 10)
		rec := httptest.NewRecorder()
		req := signedHook(trig.PublicID, old, webhook.SignV1([]byte(webhookSecretPlain), old, body), body)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
	})

	t.Run("oversize", func(t *testing.T) {
		huge := []byte(`{"environment":"prod","blob":"` + strings.Repeat("x", 400) + `"}`)
		rec := httptest.NewRecorder()
		req := signedHook(trig.PublicID, ts, webhook.SignV1([]byte(webhookSecretPlain), ts, huge), huge)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "")
	})

	t.Run("unknown trigger", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := signedHook("wh_"+strings.Repeat("0", 64), ts, sig, body)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})

	rec := httptest.NewRecorder()
	req := signedHook(trig.PublicID, ts, sig, body)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("valid delivery: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain)
	var first executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Input["env"] != "prod" || first.TriggerID != trig.ID {
		t.Fatalf("mapped input = %+v", first.Execution)
	}

	t.Run("replay", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := signedHook(trig.PublicID, ts, sig, body)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
		if !strings.Contains(rec.Body.String(), "replayed") {
			t.Fatalf("detail = %s", rec.Body.String())
		}
	})

	t.Run("rate limit", func(t *testing.T) {
		body2 := []byte(`{"environment":"staging"}`)
		ts2 := strconv.FormatInt(now.Unix()+1, 10)
		rec := httptest.NewRecorder()
		req := signedHook(trig.PublicID, ts2, webhook.SignV1([]byte(webhookSecretPlain), ts2, body2), body2)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("second allowed: %d %s", rec.Code, rec.Body.String())
		}
		body3 := []byte(`{"environment":"prod"}`)
		ts3 := strconv.FormatInt(now.Unix()+2, 10)
		rec = httptest.NewRecorder()
		req = signedHook(trig.PublicID, ts3, webhook.SignV1([]byte(webhookSecretPlain), ts3, body3), body3)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusTooManyRequests, CodeRateLimited, "")
	})

	t.Run("disabled", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/triggers/"+trig.ID+"/disable", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("disable: %d %s", rec.Code, rec.Body.String())
		}
		body4 := []byte(`{"environment":"prod"}`)
		ts4 := strconv.FormatInt(now.Unix()+10, 10)
		rec = httptest.NewRecorder()
		req = signedHook(trig.PublicID, ts4, webhook.SignV1([]byte(webhookSecretPlain), ts4, body4), body4)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+first.ID+"/audit-events", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("audit: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain)
	var listed listResponse[wfstore.AuditEvent]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range listed.Items {
		if ev.Action == "execution.start" && ev.Details["triggerType"] == "webhook" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing webhook start audit: %+v", listed.Items)
	}
}

func TestWebhookCatalogDocumentsIngressAndAdmin(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflows/catalog", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog: %d %s", rec.Code, rec.Body.String())
	}
	var cat workflow.Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatal(err)
	}
	var hook workflow.TriggerType
	for _, trig := range cat.Triggers {
		if trig.Type == "webhook" {
			hook = trig
		}
	}
	if hook.Ingress == nil || hook.Admin == nil || hook.Ingress.Session || hook.Ingress.CSRF {
		t.Fatalf("webhook catalog = %+v", hook)
	}
	if !strings.Contains(hook.Ingress.Route, "/hooks/") || !hook.Admin.SecretNeverReturned || !hook.Admin.CSRF {
		t.Fatalf("routes = %+v %+v", hook.Ingress, hook.Admin)
	}
}

func createWebhookTrigger(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, workflowID, versionID, credID string, extra map[string]any) webhook.Trigger {
	t.Helper()
	payload := map[string]any{
		"type":               "webhook",
		"workflowVersionId":  versionID,
		"secretCredentialId": credID,
	}
	for k, v := range extra {
		payload[k] = v
	}
	body, _ := json.Marshal(payload)
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+workflowID+"/triggers", body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create trigger: %d %s", rec.Code, rec.Body.String())
	}
	assertNoPlaintext(t, rec.Body.Bytes(), webhookSecretPlain)
	var trig webhook.Trigger
	if err := json.Unmarshal(rec.Body.Bytes(), &trig); err != nil {
		t.Fatal(err)
	}
	return trig
}

func signedHook(publicID, timestamp, signature string, body []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/hooks/"+publicID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(webhook.TimestampHeader, timestamp)
	req.Header.Set(webhook.SignatureHeader, signature)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}
