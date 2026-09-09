package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
)

func TestOperationalAlertsRoutingAndAck(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e54-viewer","role_keys":["viewer"]}`)
	operator := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e54-operator","role_keys":["operator"]}`)

	created := createWorkflow(t, h, admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e54")

	t.Run("authorization failure emits identifier-only alert", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowVersionId": pub.Version.ID,
			"input":             map[string]any{"token": "super-secret-token"},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

		items := listAlerts(t, h, admin, tenant, ws, "kind=authorization")
		if len(items) == 0 {
			t.Fatal("expected authorization alert")
		}
		alert := items[0]
		if alert.Action != "workflow.execute" || alert.Code != CodeForbidden || alert.ResourceID != ws.ID {
			t.Fatalf("alert = %+v", alert)
		}
		assertAlertSecretFree(t, rec.Body.Bytes())
		raw, _ := json.Marshal(alert)
		if strings.Contains(string(raw), "super-secret-token") || strings.Contains(strings.ToLower(string(raw)), "details") {
			t.Fatalf("alert JSON leaked secrets or details: %s", raw)
		}
	})

	t.Run("replay fingerprint mismatch emits replay alert", func(t *testing.T) {
		first, _ := json.Marshal(map[string]any{
			"workflowVersionId": pub.Version.ID,
			"idempotencyKey":    "e54-replay",
			"input":             map[string]any{"env": "prod", "token": "super-secret-token"},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", first, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
		}
		conflict, _ := json.Marshal(map[string]any{
			"workflowVersionId": pub.Version.ID,
			"idempotencyKey":    "e54-replay",
			"input":             map[string]any{"env": "staging", "token": "other-secret-token"},
		})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", conflict, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusConflict, CodeConflict, "")

		items := listAlerts(t, h, admin, tenant, ws, "kind=replay")
		if len(items) == 0 {
			t.Fatal("expected replay alert")
		}
		if items[0].Code != CodeConflict || items[0].Kind != opsalert.KindReplay {
			t.Fatalf("replay = %+v", items[0])
		}
		raw := rec.Body.String()
		if strings.Contains(raw, "super-secret-token") || strings.Contains(raw, "other-secret-token") {
			t.Fatal("problem leaked secrets")
		}
	})

	t.Run("policy deny emits policy alert", func(t *testing.T) {
		cred := createVaultCredential(t, h, admin, tenant, ws, "token", "E54 Cluster", map[string]string{"token": "abcdefghijklmnop"})
		pol := createOpsResource(t, h, admin, tenant, ws, "policies", "e54-deny", map[string]any{
			"kind":   "kubernetes",
			"policy": map[string]any{"deny": true},
		})
		publishOps(t, h, admin, tenant, ws, "policies", pol.Resource.ID, 1, "deny")
		target := createOpsResource(t, h, admin, tenant, ws, "cluster-targets", "e54-cluster", clusterSpecWithPolicy(cred.ID, pol.Resource.ID))
		publishOps(t, h, admin, tenant, ws, "cluster-targets", target.Resource.ID, 1, "initial")
		wf := createWorkflow(t, h, admin, tenant, ws, workflowYAMLWithTarget(target.Resource.ID))
		denied := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "deny-run")
		body, _ := json.Marshal(map[string]any{"workflowVersionId": denied.Version.ID})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

		items := listAlerts(t, h, admin, tenant, ws, "kind=policy&resourceId="+wf.Workflow.ID)
		if len(items) == 0 {
			t.Fatal("expected policy alert")
		}
		if items[0].Severity != opsalert.SeverityCritical || items[0].ResourceID != wf.Workflow.ID {
			t.Fatalf("policy = %+v", items[0])
		}
	})

	t.Run("redaction failure emits redaction alert", func(t *testing.T) {
		exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
		detail := fetchExecutionDetail(t, h, admin, tenant, ws, exec.ID)
		if len(detail.Steps) == 0 {
			t.Fatal("expected a step")
		}
		body, _ := json.Marshal(map[string]any{
			"kind":                  "file",
			"filename":              "key.pem",
			"contentType":           "text/plain",
			"contentClassification": "internal",
			"content":               "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec.ID+"/steps/"+detail.Steps[0].ID+"/artifacts", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
		if strings.Contains(rec.Body.String(), "BEGIN RSA") {
			t.Fatal("problem leaked key material")
		}

		items := listAlerts(t, h, admin, tenant, ws, "kind=redaction&resourceId="+exec.ID)
		if len(items) == 0 {
			t.Fatal("expected redaction alert")
		}
		if items[0].ResourceID != exec.ID || items[0].Severity != opsalert.SeverityCritical {
			t.Fatalf("redaction = %+v", items[0])
		}
	})

	t.Run("viewer lists and cannot ack; operator acks", func(t *testing.T) {
		items := listAlerts(t, h, viewer.User, tenant, ws, "status=open")
		if len(items) == 0 {
			t.Fatal("viewer should list alerts")
		}
		id := items[0].ID
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/alerts/"+id+"/ack", []byte(`{}`), viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/alerts/"+id+"/ack", []byte(`{}`), operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("ack: %d %s", rec.Code, rec.Body.String())
		}
		var acked opsalert.Alert
		if err := json.Unmarshal(rec.Body.Bytes(), &acked); err != nil {
			t.Fatal(err)
		}
		if acked.AcknowledgedAt == nil || acked.AcknowledgedBy == "" {
			t.Fatalf("acked = %+v", acked)
		}
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/alerts/"+id+"/ack", []byte(`{}`), operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("idempotent ack: %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("cross-workspace alert id is 404", func(t *testing.T) {
		items := listAlerts(t, h, admin, tenant, ws, "")
		if len(items) == 0 {
			t.Fatal("expected alerts")
		}
		rec := httptest.NewRecorder()
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"e54-b","name":"B"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("workspace B: %d %s", rec.Code, rec.Body.String())
		}
		var wsB identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
			t.Fatal(err)
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/alerts/"+items[0].ID, nil, admin, tenant, wsB)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	})

	t.Run("host-supplied workspace id on ack is 400", func(t *testing.T) {
		items := listAlerts(t, h, admin, tenant, ws, "")
		body := `{"workspaceId":"33333333-3333-4333-8333-333333333333"}`
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodPost, "/api/v1/alerts/"+items[0].ID+"/ack", strings.NewReader(body), admin, tenant, ws)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})
}

func listAlerts(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, query string) []opsalert.Alert {
	t.Helper()
	path := "/api/v1/alerts"
	if query != "" {
		path += "?" + query
	}
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, path, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list alerts %s: %d %s", query, rec.Code, rec.Body.String())
	}
	assertAlertSecretFree(t, rec.Body.Bytes())
	var listed listResponse[opsalert.Alert]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	return listed.Items
}

func assertAlertSecretFree(t *testing.T, raw []byte) {
	t.Helper()
	body := strings.ToLower(string(raw))
	for _, needle := range []string{"super-secret", "bearer ", "begin rsa", "password", "change-me@", "dek_envelope", "storage_ref"} {
		if strings.Contains(body, needle) {
			t.Fatalf("secret material in response: %s", raw)
		}
	}
}

func TestAlertsRequireAuth(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/alerts", nil))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}
