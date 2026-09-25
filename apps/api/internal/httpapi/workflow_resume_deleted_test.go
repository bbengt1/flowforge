package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestApprovalDecideAfterDeleteStopsTheRun(t *testing.T) {
	var frozen atomic.Int64
	base := time.Now().UTC().Add(time.Second)
	frozen.Store(base.UnixNano())
	h, admin := seededWorkspaceWithClock(t, func() time.Time {
		return time.Unix(0, frozen.Load()).UTC()
	})
	ws, tenant := currentWorkspace(t, h, admin)
	approver := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"resume-approver","role_keys":["approver"]}`)

	wf := createWorkflow(t, h, admin, tenant, ws, approvalWaitYAMLNamed("resume-deleted"))
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "wait")
	exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"resume-worker","leaseSeconds":5}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+wf.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals?executionId="+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list approvals: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[approval.Record]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed.Items) != 1 {
		t.Fatalf("approvals = %s %v", rec.Body.String(), err)
	}
	body, _ := json.Marshal(map[string]string{"decision": "approved"})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/approvals/"+listed.Items[0].ID+"/decide", body, approver.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeApprovalClosed, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+listed.Items[0].ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	var still approval.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &still); err != nil {
		t.Fatal(err)
	}
	if still.Status != approval.StatusCanceled || still.CloseReason != approval.ReasonWorkflowDeleted || still.DecidedBy != "" {
		t.Fatalf("approval = %+v", still)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("execution: %d %s", rec.Code, rec.Body.String())
	}
	var detail struct {
		Status       string `json:"status"`
		StatusReason string `json:"statusReason"`
		Steps        []struct {
			Error  map[string]any `json:"error"`
			Output map[string]any `json:"output"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Status != wfstore.ExecutionFailed || detail.StatusReason != wfstore.ReasonWorkflowDeleted {
		t.Fatalf("detail = %+v", detail)
	}
	if len(detail.Steps) == 0 || detail.Steps[0].Error["code"] != wfstore.ReasonWorkflowDeleted {
		t.Fatalf("steps = %+v", detail.Steps)
	}
	if detail.Steps[0].Output["port"] == "approved" {
		t.Fatal("approved port must not be written")
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+wf.Workflow.ID+"/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec.ID+"/retry", []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeWorkflowDeleted, "")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/executions", []byte(`{"workflowVersionId":"`+pub.Version.ID+`"}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
}

func TestTimerRecoverAfterDeleteDoesNotExpire(t *testing.T) {
	var frozen atomic.Int64
	base := time.Now().UTC().Add(time.Second)
	frozen.Store(base.UnixNano())
	h, admin := seededWorkspaceWithClock(t, func() time.Time {
		return time.Unix(0, frozen.Load()).UTC()
	})
	ws, tenant := currentWorkspace(t, h, admin)
	wf := createWorkflow(t, h, admin, tenant, ws, approvalWaitYAMLNamed("timer-deleted"))
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "wait")
	exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"timer-worker","leaseSeconds":5}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+wf.Workflow.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	frozen.Store(base.Add(20 * time.Minute).UnixNano())
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/recover", []byte(`{}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("recover: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	var detail struct {
		Status string `json:"status"`
		Steps  []struct {
			Output map[string]any `json:"output"`
			Error  map[string]any `json:"error"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Status != wfstore.ExecutionFailed {
		t.Fatalf("status = %s body=%s", detail.Status, rec.Body.String())
	}
	for _, step := range detail.Steps {
		if step.Output["port"] == "expired" {
			t.Fatalf("expired port = %+v", step.Output)
		}
		if step.Error["code"] != wfstore.ReasonWorkflowDeleted {
			t.Fatalf("error = %+v", step.Error)
		}
	}
}
