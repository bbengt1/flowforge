package workflowhttp

import (
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Additive execution detail reason when queued jobs sit unclaimed.
// Chloe can surface this; it does not change status or fencing.
const (
	StatusReasonNoWorker       = "no-worker"
	DefaultQueuedNoWorkerAfter = 15 * time.Second
)

func listWorkspaceExecutions(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	filter, ok := bindExecutionPage(w, r)
	if !ok {
		return
	}
	items, err := s.Workflows.ListExecutions(r.Context(), scope, filter)
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WritePage(w, items, filter.Page, pageNext(filter.Page))
}

func listWorkflowExecutions(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	filter, ok := bindExecutionPage(w, r)
	if !ok {
		return
	}
	filter.WorkflowID = strings.TrimSpace(r.PathValue("workflowId"))
	items, err := s.Workflows.ListExecutions(r.Context(), scope, filter)
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WritePage(w, items, filter.Page, pageNext(filter.Page))
}

func getWorkspaceExecution(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	exec, err := s.Workflows.GetExecutionByID(r.Context(), scope, strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	WriteExecutionDetail(s, w, r, scope, exec, http.StatusOK)
}

func listExecutionSteps(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	exec, err := s.Workflows.GetExecutionByID(r.Context(), scope, executionID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	items, err := s.Workflows.ListSteps(r.Context(), scope, executionID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if err := s.Workflows.AnnotateRetryCapabilities(r.Context(), scope, &exec, items); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.ListResponse[wfstore.ExecutionStep]{Items: wfstore.BoundSteps(items)})
}

func getExecutionStep(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	stepID := strings.TrimSpace(r.PathValue("stepId"))
	exec, err := s.Workflows.GetExecutionByID(r.Context(), scope, executionID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	steps, err := s.Workflows.ListSteps(r.Context(), scope, executionID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if err := s.Workflows.AnnotateRetryCapabilities(r.Context(), scope, &exec, steps); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	for _, step := range steps {
		if step.ID == stepID {
			core.WriteJSON(w, http.StatusOK, wfstore.BoundStep(step))
			return
		}
	}
	WriteWorkflowStoreError(w, r, wfstore.ErrNotFound)
}

func listExecutionJobs(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	items, err := s.Workflows.ListJobs(r.Context(), scope, strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.ListResponse[wfstore.ExecutionJob]{Items: items})
}

func listExecutionAuditEvents(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	if _, err := s.Workflows.GetExecutionByID(r.Context(), scope, executionID); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	q, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	var next string
	q.Next = &next
	items, err := s.Workflows.ListAuditEvents(r.Context(), scope, wfstore.AuditListFilter{
		ResourceType: "execution",
		ResourceID:   executionID,
		Page:         q,
	})
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WritePage(w, items, q, next)
}

func listProductAuditEvents(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	q, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	var next string
	q.Next = &next
	items, err := s.Workflows.ListAuditEvents(r.Context(), scope, wfstore.AuditListFilter{
		ResourceType: strings.TrimSpace(r.URL.Query().Get("resourceType")),
		ResourceID:   strings.TrimSpace(r.URL.Query().Get("resourceId")),
		Action:       strings.TrimSpace(r.URL.Query().Get("action")),
		Page:         q,
	})
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WritePage(w, items, q, next)
}

func WriteExecutionDetail(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, exec wfstore.Execution, status int) {
	pins := []opsconfig.Pin{}
	if s.Ops != nil {
		listed, err := s.Ops.ListPins(r.Context(), scope, opsconfig.OwnerExecution, exec.ID)
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		pins = listed
	}
	steps, err := s.Workflows.ListSteps(r.Context(), scope, exec.ID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	jobs, err := s.Workflows.ListJobs(r.Context(), scope, exec.ID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	audits, err := s.Workflows.ListAuditEvents(r.Context(), scope, wfstore.AuditListFilter{
		ResourceType: "execution",
		ResourceID:   exec.ID,
		Limit:        wfstore.DefaultListLimit,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if steps == nil {
		steps = []wfstore.ExecutionStep{}
	}
	if err := s.Workflows.AnnotateRetryCapabilities(r.Context(), scope, &exec, steps); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if jobs == nil {
		jobs = []wfstore.ExecutionJob{}
	}
	if audits == nil {
		audits = []wfstore.AuditEvent{}
	}
	arts, err := s.Workflows.ListArtifacts(r.Context(), scope, wfstore.ArtifactListFilter{ExecutionID: exec.ID})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, status, ExecutionResponse{
		Execution:    exec,
		StatusReason: ExecutionStatusReason(exec, steps, jobs, Now(s)),
		Pins:         pins,
		Steps:        wfstore.BoundSteps(steps),
		Jobs:         jobs,
		AuditEvents:  audits,
		Artifacts:    publicArtifacts(arts),
	})
}

// ExecutionStatusReason surfaces requirement_unresolvable, then
// workflow_deleted, on a failed run, then the queued no-worker hint.
// Workflow-scoped execution routes stay 404.
func ExecutionStatusReason(exec wfstore.Execution, steps []wfstore.ExecutionStep, jobs []wfstore.ExecutionJob, now time.Time) string {
	if exec.Status == wfstore.ExecutionFailed {
		var deleted bool
		for _, step := range steps {
			code, _ := step.Error["code"].(string)
			if code == wfstore.ReasonRequirementUnresolvable {
				return wfstore.ReasonRequirementUnresolvable
			}
			if code == wfstore.ReasonWorkflowDeleted {
				deleted = true
			}
		}
		if deleted {
			return wfstore.ReasonWorkflowDeleted
		}
	}
	return QueuedUnclaimedReason(exec, jobs, now)
}

// QueuedUnclaimedReason is an operator-visible hint when a run is still
// queued and no worker has claimed any job after a short grace period.
func QueuedUnclaimedReason(exec wfstore.Execution, jobs []wfstore.ExecutionJob, now time.Time) string {
	if exec.Status != wfstore.ExecutionQueued {
		return ""
	}
	var oldest time.Time
	sawQueued := false
	for _, job := range jobs {
		if job.Status == wfstore.JobBlocked || job.Status == wfstore.JobSkipped {
			continue
		}
		if job.Status != wfstore.JobQueued || strings.TrimSpace(job.WorkerID) != "" {
			return ""
		}
		sawQueued = true
		if oldest.IsZero() || job.AvailableAt.Before(oldest) {
			oldest = job.AvailableAt
		}
	}
	if !sawQueued || oldest.IsZero() {
		return ""
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if now.Sub(oldest) < DefaultQueuedNoWorkerAfter {
		return ""
	}
	return StatusReasonNoWorker
}

func executionFilterFromQuery(r *http.Request) wfstore.ExecutionListFilter {
	return wfstore.ExecutionListFilter{
		WorkflowID: strings.TrimSpace(r.URL.Query().Get("workflowId")),
		Status:     strings.TrimSpace(r.URL.Query().Get("status")),
	}
}

func bindExecutionPage(w http.ResponseWriter, r *http.Request) (wfstore.ExecutionListFilter, bool) {
	q, ok := core.ParsePage(w, r)
	if !ok {
		return wfstore.ExecutionListFilter{}, false
	}
	filter := executionFilterFromQuery(r)
	var next string
	q.Next = &next
	filter.Page = q
	return filter, true
}

func pageNext(q page.Query) string {
	if q.Next == nil {
		return ""
	}
	return *q.Next
}
