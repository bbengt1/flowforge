package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const typedManualStartYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e10-manual
spec:
  triggers:
    - id: manual
      type: manual
      schema:
        type: object
        additionalProperties: false
        required: [env]
        properties:
          env:
            type: string
            enum: [prod, staging]
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`

func TestManualStartRequiresPublishedVersionAndExecute(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, typedManualStartYAML)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e101-viewer","role_keys":["viewer"]}`)

	t.Run("missing version", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"idempotencyKey": "m-missing-version"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
		if !strings.Contains(rec.Body.String(), "Drafts cannot be executed") {
			t.Fatalf("detail = %s", rec.Body.String())
		}
	})

	t.Run("draft flag", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"draft": true, "idempotencyKey": "m-draft-flag"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e10")

	t.Run("viewer cannot start", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowVersionId": pub.Version.ID,
			"idempotencyKey":    "m-viewer-deny",
			"input":             map[string]any{"env": "prod"},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})
}

func TestManualStartIdempotencyInputBoundsAndAudit(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, typedManualStartYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e10-run")

	t.Run("schema mismatch", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowVersionId": pub.Version.ID,
			"idempotencyKey":    "m-schema-bad",
			"input":             map[string]any{"env": "dev"},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
		if len(p.Errors) == 0 {
			t.Fatalf("expected field errors: %s", rec.Body.String())
		}
	})

	t.Run("input bound", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"workflowVersionId": pub.Version.ID,
			"idempotencyKey":    "m-too-big",
			"input":             map[string]any{"env": "prod", "blob": strings.Repeat("x", workflow.MaxPortBytes+8)},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
		if !strings.Contains(rec.Body.String(), "byte size bound") {
			t.Fatalf("detail = %s", rec.Body.String())
		}
	})

	body, _ := json.Marshal(map[string]any{
		"workflowVersionId": pub.Version.ID,
		"idempotencyKey":    "m-e10-run-1",
		"input":             map[string]any{"env": "prod"},
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
	var first executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Replayed || first.WorkflowDigest == "" || first.Input["env"] != "prod" {
		t.Fatalf("first = %+v", first.Execution)
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("replay: %d %s", rec.Code, rec.Body.String())
	}
	var replay executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || replay.ID != first.ID {
		t.Fatalf("replay = %+v", replay.Execution)
	}

	conflict, _ := json.Marshal(map[string]any{
		"workflowVersionId": pub.Version.ID,
		"idempotencyKey":    "m-e10-run-1",
		"input":             map[string]any{"env": "staging"},
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", conflict, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+first.ID+"/audit-events", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("audit: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "super-secret-token") {
		t.Fatal("audit leaked secret")
	}
	var listed listResponse[wfstore.AuditEvent]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	foundCreated := false
	foundReplay := false
	for _, ev := range listed.Items {
		if ev.Action != "execution.start" {
			continue
		}
		if ev.ActorID == "" || ev.Details["workflowDigest"] != first.WorkflowDigest {
			t.Fatalf("start audit missing actor/digest: %+v", ev)
		}
		if ev.Details["workflowVersionId"] != pub.Version.ID || ev.Details["triggerType"] != "manual" {
			t.Fatalf("start audit pin: %#v", ev.Details)
		}
		if ev.CorrelationID == "" && ev.Details["correlationId"] == "" {
			t.Fatalf("start audit missing correlation: %+v", ev)
		}
		switch ev.Outcome {
		case "created":
			foundCreated = true
		case "replayed":
			foundReplay = true
		}
	}
	if !foundCreated || !foundReplay {
		t.Fatalf("expected created+replayed start audits: %+v", listed.Items)
	}
}

func TestManualStartCatalogDocumentsRunDialog(t *testing.T) {
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
	var manual workflow.TriggerType
	for _, trig := range cat.Triggers {
		if trig.Type == "manual" {
			manual = trig
		}
	}
	if manual.Start == nil || !manual.Start.CSRF || manual.Start.Permission != "workflow.execute" {
		t.Fatalf("manual start catalog = %+v", manual)
	}
	if !strings.Contains(manual.Start.Help, "idempotency") || !strings.Contains(manual.Start.Route, "/executions") {
		t.Fatalf("help/route = %+v", manual.Start)
	}
}
