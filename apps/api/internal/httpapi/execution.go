package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func (s *Server) listWorkspaceExecutions(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	filter := executionFilterFromQuery(r)
	items, err := s.workflows.ListExecutions(r.Context(), scope, filter)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.Execution]{Items: items})
}

func (s *Server) listWorkflowExecutions(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	filter := executionFilterFromQuery(r)
	filter.WorkflowID = strings.TrimSpace(r.PathValue("workflowId"))
	items, err := s.workflows.ListExecutions(r.Context(), scope, filter)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.Execution]{Items: items})
}

func (s *Server) getWorkspaceExecution(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	exec, err := s.workflows.GetExecutionByID(r.Context(), scope, strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	s.writeExecutionDetail(w, r, scope, exec, http.StatusOK)
}

func (s *Server) listExecutionSteps(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	items, err := s.workflows.ListSteps(r.Context(), scope, strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.ExecutionStep]{Items: wfstore.BoundSteps(items)})
}

func (s *Server) getExecutionStep(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	step, err := s.workflows.GetStep(r.Context(), scope, strings.TrimSpace(r.PathValue("executionId")), strings.TrimSpace(r.PathValue("stepId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wfstore.BoundStep(step))
}

func (s *Server) listExecutionJobs(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	items, err := s.workflows.ListJobs(r.Context(), scope, strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.ExecutionJob]{Items: items})
}

func (s *Server) listExecutionAuditEvents(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	if _, err := s.workflows.GetExecutionByID(r.Context(), scope, executionID); err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	items, err := s.workflows.ListAuditEvents(r.Context(), scope, wfstore.AuditListFilter{
		ResourceType: "execution",
		ResourceID:   executionID,
		Limit:        queryLimit(r),
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.AuditEvent]{Items: items})
}

func (s *Server) listProductAuditEvents(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	items, err := s.workflows.ListAuditEvents(r.Context(), scope, wfstore.AuditListFilter{
		ResourceType: strings.TrimSpace(r.URL.Query().Get("resourceType")),
		ResourceID:   strings.TrimSpace(r.URL.Query().Get("resourceId")),
		Action:       strings.TrimSpace(r.URL.Query().Get("action")),
		Limit:        queryLimit(r),
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.AuditEvent]{Items: items})
}

func (s *Server) writeExecutionDetail(w http.ResponseWriter, r *http.Request, scope isolation.Scope, exec wfstore.Execution, status int) {
	pins := []opsconfig.Pin{}
	if s.ops != nil {
		listed, err := s.ops.ListPins(r.Context(), scope, opsconfig.OwnerExecution, exec.ID)
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		pins = listed
	}
	steps, err := s.workflows.ListSteps(r.Context(), scope, exec.ID)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	jobs, err := s.workflows.ListJobs(r.Context(), scope, exec.ID)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	audits, err := s.workflows.ListAuditEvents(r.Context(), scope, wfstore.AuditListFilter{
		ResourceType: "execution",
		ResourceID:   exec.ID,
		Limit:        wfstore.DefaultListLimit,
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	if steps == nil {
		steps = []wfstore.ExecutionStep{}
	}
	if jobs == nil {
		jobs = []wfstore.ExecutionJob{}
	}
	if audits == nil {
		audits = []wfstore.AuditEvent{}
	}
	arts, err := s.workflows.ListArtifacts(r.Context(), scope, wfstore.ArtifactListFilter{ExecutionID: exec.ID})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, status, executionResponse{
		Execution:   exec,
		Pins:        pins,
		Steps:       wfstore.BoundSteps(steps),
		Jobs:        jobs,
		AuditEvents: audits,
		Artifacts:   publicArtifacts(arts),
	})
}

func executionFilterFromQuery(r *http.Request) wfstore.ExecutionListFilter {
	return wfstore.ExecutionListFilter{
		WorkflowID: strings.TrimSpace(r.URL.Query().Get("workflowId")),
		Status:     strings.TrimSpace(r.URL.Query().Get("status")),
		Limit:      queryLimit(r),
	}
}

func queryLimit(r *http.Request) int {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return n
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
