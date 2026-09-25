package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestWorkflowSoftDelete(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	editor := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-delete-editor","display_name":"Editor","role_keys":["editor"]}`)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-delete-viewer","display_name":"Viewer","role_keys":["viewer"]}`)
	publisher := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-delete-publisher","display_name":"Publisher","role_keys":["publisher"]}`)

	owned := createWorkflow(t, h, editor.User, tenant, ws, strings.Replace(validWorkflowYAML, "name: restart-api-rollout", "name: editor-owned", 1))
	if !owned.Workflow.Capabilities.Delete {
		t.Fatal("editor create must report capabilities.delete")
	}
	adminWF := createWorkflow(t, h, admin, tenant, ws, strings.Replace(validWorkflowYAML, "name: restart-api-rollout", "name: admin-owned", 1))
	if !adminWF.Workflow.Capabilities.Delete {
		t.Fatal("admin create must report capabilities.delete")
	}

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer get: %d %s", rec.Code, rec.Body.String())
	}
	var viewerView struct {
		Capabilities struct {
			Delete bool `json:"delete"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &viewerView); err != nil {
		t.Fatal(err)
	}
	if viewerView.Capabilities.Delete {
		t.Fatal("viewer capabilities.delete must be false")
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, publisher.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")

	stranger := workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, admin, tenant, ws)
	stranger.Header.Set(headerSubject, "no-membership-delete")
	stranger.Header.Set(headerDisplayName, "Stranger")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, stranger)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	wsB := createSecondWorkspace(t, h, admin, tenant)
	outsider := putMember(t, h, admin, tenant, wsB, `{"issuer":"https://idp.example","external_subject":"wf-delete-outsider","display_name":"Outsider","role_keys":["admin"]}`)
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, outsider.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, outsider.User, tenant, wsB)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, editor.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("editor delete: %d %s", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("editor delete body = %q", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+adminWF.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-delete-editor","display_name":"Editor","role_keys":["viewer"]}`)
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+owned.Workflow.ID, nil, editor.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner get: %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &viewerView); err != nil {
		t.Fatal(err)
	}
	if !viewerView.Capabilities.Delete {
		t.Fatal("owner demoted to viewer must still have capabilities.delete")
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+owned.Workflow.ID, nil, editor.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("owner delete: %d %s", rec.Code, rec.Body.String())
	}

	for _, route := range Routes(nil) {
		if route.Method == http.MethodDelete && strings.Contains(route.Pattern, "/embed/") {
			t.Fatalf("embed delete route %s", route.Pattern)
		}
	}
}

func TestWorkflowDeleteUnpublishesAndReservesSlug(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, typedWebhookYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "delete-me")
	cred := createVaultCredential(t, h, admin, tenant, ws, "webhook_secret", "Hook", map[string]string{"secret": webhookSecretPlain})
	body, _ := json.Marshal(map[string]any{
		"type":               "webhook",
		"workflowVersionId":  pub.Version.ID,
		"secretCredentialId": cred.ID,
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/triggers", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("trigger: %d %s", rec.Code, rec.Body.String())
	}
	var trig struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &trig); err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(map[string]any{
		"workflowId":        created.Workflow.ID,
		"workflowVersionId": pub.Version.ID,
		"timezone":          "UTC",
		"interval":          "PT15M",
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/schedules", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("schedule: %d %s", rec.Code, rec.Body.String())
	}
	var sched struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &sched); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+created.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/versions/"+pub.Version.ID+"/export", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/triggers", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/triggers/"+trig.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/triggers/"+trig.ID+"/enable", []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPatch, "/api/v1/triggers/"+trig.ID, []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/schedules/"+sched.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/schedules", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("schedule list: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), sched.ID) {
		t.Fatalf("tombstoned schedule still listed: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/schedules/"+sched.ID+"/enable", []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPatch, "/api/v1/schedules/"+sched.ID, []byte(`{"interval":"PT30M"}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows?q=e10-webhook", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("search: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), created.Workflow.ID) {
		t.Fatalf("deleted workflow still listed: %s", rec.Body.String())
	}

	body, _ = json.Marshal(map[string]string{
		"definitionYaml": typedWebhookYAML,
		"slug":           created.Workflow.Slug,
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeWorkflowSlugReserved, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/audit-events?action=workflow.deleted&resourceId="+created.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("audit: %d %s", rec.Code, rec.Body.String())
	}
	raw, err := io.ReadAll(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "definitionYaml") || strings.Contains(string(raw), webhookSecretPlain) {
		t.Fatalf("audit leaked yaml or secret: %s", raw)
	}
	var audits listResponse[wfstore.AuditEvent]
	if err := json.Unmarshal(raw, &audits); err != nil {
		t.Fatal(err)
	}
	if len(audits.Items) != 1 {
		t.Fatalf("audits = %+v", audits.Items)
	}
	ev := audits.Items[0]
	if ev.ActorID != admin.ID || ev.ResourceID != created.Workflow.ID || ev.Action != "workflow.deleted" || ev.OccurredAt.IsZero() {
		t.Fatalf("audit event = %+v", ev)
	}
	if ev.Details["published"] != true || ev.Details["name"] == "" || ev.Details["tenantId"] != tenant.ID {
		t.Fatalf("details = %+v", ev.Details)
	}
}

func TestWorkflowDeleteRejectsActiveExecution(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, typedWebhookYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "run")
	startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+created.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeWorkflowHasActiveExecutions, "")
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("workflow must stay after 409: %d %s", rec.Code, rec.Body.String())
	}
}
