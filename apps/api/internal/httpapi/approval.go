package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

type evaluateRequest struct {
	ID                string `json:"id"`
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceIDAlt    string `json:"workspaceId"`
	WorkflowID        string `json:"workflowId"`
	WorkflowVersionID string `json:"workflowVersionId"`
}

type createApprovalsRequest struct {
	ID                string `json:"id"`
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceIDAlt    string `json:"workspaceId"`
	WorkflowID        string `json:"workflowId"`
	WorkflowVersionID string `json:"workflowVersionId"`
	ExecutionID       string `json:"executionId"`
	NodeID            string `json:"nodeId"`
}

type decideApprovalRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Decision       string `json:"decision"`
	Note           string `json:"note"`
}

type evaluateResponse struct {
	policy.Result
	Approvals []approval.Record `json:"approvals"`
}

func (s *Server) requireApprovals(w http.ResponseWriter, r *http.Request) bool {
	if s.approvals != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Approval store is not available.")
	return false
}

func (s *Server) approvalScope(w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !s.requireApprovals(w, r) {
		return isolation.Scope{}, false
	}
	return s.requireScope(w, r, user, perm)
}

func (s *Server) getApprovalCatalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.approvalScope(w, r, authz.PermApprovalView); !ok {
		return
	}
	writeJSON(w, http.StatusOK, approval.TypeCatalog())
}

func (s *Server) evaluatePolicy(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.approvalScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	var req evaluateRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	eval, records, err := s.evaluateAndList(r.Context(), scope, strings.TrimSpace(req.WorkflowID), strings.TrimSpace(req.WorkflowVersionID), "")
	if err != nil {
		writeApprovalEvalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, evaluateResponse{Result: eval, Approvals: records})
}

func (s *Server) listApprovals(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.approvalScope(w, r, authz.PermApprovalView)
	if !ok {
		return
	}
	q := r.URL.Query()
	items, err := s.approvals.List(r.Context(), scope, approval.Filter{
		Status:            strings.TrimSpace(q.Get("status")),
		WorkflowID:        strings.TrimSpace(q.Get("workflowId")),
		WorkflowVersionID: strings.TrimSpace(q.Get("workflowVersionId")),
		ExecutionID:       strings.TrimSpace(q.Get("executionId")),
	})
	if err != nil {
		writeApprovalError(w, r, err)
		return
	}
	now := s.clock().UTC()
	out := make([]approval.Record, 0, len(items))
	for _, rec := range items {
		rec = s.refreshRecord(r.Context(), scope, rec, now)
		out = append(out, rec)
	}
	writeJSON(w, http.StatusOK, listResponse[approval.Record]{Items: out})
}

func (s *Server) createApprovals(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.approvalScope(w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req createApprovalsRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	eval, err := s.evaluateVersion(r.Context(), scope, strings.TrimSpace(req.WorkflowID), strings.TrimSpace(req.WorkflowVersionID))
	if err != nil {
		writeApprovalEvalError(w, r, err)
		return
	}
	if eval.Decision == policy.DecisionDeny {
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", denyDetail(eval))
		return
	}
	reqs := eval.Requirements
	if node := strings.TrimSpace(req.NodeID); node != "" {
		filtered := reqs[:0]
		for _, item := range reqs {
			if item.NodeID == node {
				filtered = append(filtered, item)
			}
		}
		reqs = filtered
		if len(reqs) == 0 {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "No approval requirement exists for that node.")
			return
		}
	}
	created, err := s.materializeRequirements(r.Context(), scope, strings.TrimSpace(req.WorkflowID), strings.TrimSpace(req.WorkflowVersionID), eval.WorkflowDigest, strings.TrimSpace(req.ExecutionID), reqs)
	if err != nil {
		writeApprovalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, listResponse[approval.Record]{Items: created})
}

func (s *Server) getApproval(w http.ResponseWriter, r *http.Request) {
	if reservedApprovalCollection(r.PathValue("approvalId")) {
		WriteProblem(w, r, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed", "The "+r.Method+" method is not allowed for this path.")
		return
	}
	scope, ok := s.approvalScope(w, r, authz.PermApprovalView)
	if !ok {
		return
	}
	rec, err := s.approvals.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("approvalId")))
	if err != nil {
		writeApprovalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.refreshRecord(r.Context(), scope, rec, s.clock().UTC()))
}

func (s *Server) decideApproval(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireApprovals(w, r) {
		return
	}
	// Fresh server-side authorization at decision time — do not reuse a cached grant.
	ws, _, roles, _, ok := s.requireAccess(w, r, user, authz.PermApprovalDecide)
	if !ok {
		return
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, ws.TenantID, ws.WorkbenchKey)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	var req decideApprovalRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	rec, err := s.approvals.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("approvalId")))
	if err != nil {
		writeApprovalError(w, r, err)
		return
	}
	if !approval.HasApproverRole(roles, rec.ApproverRole) {
		WriteForbidden(w, r)
		return
	}
	heads := s.headsFor(r.Context(), scope, rec)
	out, err := s.approvals.Decide(r.Context(), scope, rec.ID, approval.DecideInput{
		Decision: req.Decision,
		Note:     req.Note,
		Now:      s.clock().UTC(),
		Heads:    heads,
	})
	if err != nil {
		writeApprovalError(w, r, err)
		return
	}
	s.resumeApprovalWait(r.Context(), scope, out, out.Status)
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listApprovalEvents(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.approvalScope(w, r, authz.PermApprovalView)
	if !ok {
		return
	}
	items, err := s.approvals.Events(r.Context(), scope, strings.TrimSpace(r.PathValue("approvalId")))
	if err != nil {
		writeApprovalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[approval.Event]{Items: items})
}

func reservedApprovalCollection(id string) bool {
	return strings.TrimSpace(id) == "catalog"
}

func (s *Server) evaluateVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (policy.Result, error) {
	if s.workflows == nil {
		return policy.Result{}, wfstore.ErrStoreUnavailable
	}
	ver, err := s.workflows.GetVersion(ctx, scope, workflowID, versionID)
	if err != nil {
		return policy.Result{}, err
	}
	pins, err := s.resolveEvalPins(ctx, scope, ver.DefinitionYAML)
	if err != nil {
		return policy.Result{}, err
	}
	return policy.Evaluate(policy.Input{
		YAML:              ver.DefinitionYAML,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Pins:              pins,
		Now:               s.clock().UTC(),
	})
}

func (s *Server) resolveEvalPins(ctx context.Context, scope isolation.Scope, yamlDoc string) ([]opsconfig.Pin, error) {
	if s.ops == nil {
		return []opsconfig.Pin{}, nil
	}
	refs := opsconfig.ExtractRefs(yamlDoc)
	if len(refs) == 0 {
		return []opsconfig.Pin{}, nil
	}
	pins, err := s.ops.Resolve(ctx, scope, refs)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	for _, pin := range pins {
		seen[pin.ResourceID] = struct{}{}
	}
	var extra []opsconfig.Ref
	addPolicy := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		extra = append(extra, opsconfig.Ref{Kind: opsconfig.KindPolicy, ResourceID: id})
	}
	for _, pin := range pins {
		if pin.Spec != nil {
			if id, _ := pin.Spec["policyId"].(string); id != "" {
				addPolicy(id)
			}
		}
	}
	if len(extra) == 0 {
		return pins, nil
	}
	more, err := s.ops.Resolve(ctx, scope, extra)
	if err != nil {
		return nil, err
	}
	return append(pins, more...), nil
}

func (s *Server) evaluateAndList(ctx context.Context, scope isolation.Scope, workflowID, versionID, executionID string) (policy.Result, []approval.Record, error) {
	eval, err := s.evaluateVersion(ctx, scope, workflowID, versionID)
	if err != nil {
		return policy.Result{}, nil, err
	}
	if s.approvals == nil {
		return eval, []approval.Record{}, nil
	}
	items, err := s.approvals.List(ctx, scope, approval.Filter{WorkflowVersionID: versionID, ExecutionID: executionID})
	if err != nil {
		return eval, nil, err
	}
	now := s.clock().UTC()
	out := make([]approval.Record, 0, len(items))
	for _, rec := range items {
		out = append(out, s.refreshRecord(ctx, scope, rec, now))
	}
	return eval, out, nil
}

func (s *Server) materializeRequirements(ctx context.Context, scope isolation.Scope, workflowID, versionID, digest, executionID string, reqs []policy.Requirement) ([]approval.Record, error) {
	out := make([]approval.Record, 0, len(reqs))
	for _, req := range reqs {
		rec, err := s.approvals.Create(ctx, scope, approval.CreateInput{
			WorkflowID:        workflowID,
			WorkflowVersionID: versionID,
			WorkflowDigest:    digest,
			ExecutionID:       executionID,
			Requirement:       req,
		})
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, nil
}

func (s *Server) refreshRecord(ctx context.Context, scope isolation.Scope, rec approval.Record, now time.Time) approval.Record {
	if s.approvals == nil {
		return rec
	}
	heads := s.headsFor(ctx, scope, rec)
	out, err := s.approvals.Refresh(ctx, scope, rec.ID, heads, now)
	if err != nil {
		return rec
	}
	if rec.ExecutionID != "" && rec.Status == approval.StatusPending &&
		(out.Status == approval.StatusExpired || out.Status == approval.StatusInvalidated) {
		s.resumeApprovalWait(ctx, scope, out, "expired")
	}
	return out
}

func (s *Server) headsFor(ctx context.Context, scope isolation.Scope, rec approval.Record) approval.CurrentHeads {
	heads := approval.CurrentHeads{WorkflowDigest: rec.WorkflowDigest}
	if s.workflows != nil && rec.WorkflowID != "" && rec.WorkflowVersionID != "" {
		if ver, err := s.workflows.GetVersion(ctx, scope, rec.WorkflowID, rec.WorkflowVersionID); err == nil {
			heads.WorkflowDigest = ver.Digest
		}
	}
	if s.ops == nil {
		return heads
	}
	if rec.TargetID != "" && rec.TargetKind != "" {
		if target, err := s.ops.Get(ctx, scope, rec.TargetKind, rec.TargetID); err == nil {
			heads.TargetLatestVersionID = target.LatestVersionID
			heads.TargetDisabled = target.Status == opsconfig.StatusDisabled
		}
	}
	if rec.PolicyResourceID != "" {
		if pol, err := s.ops.Get(ctx, scope, opsconfig.KindPolicy, rec.PolicyResourceID); err == nil {
			heads.PolicyLatestVersionID = pol.LatestVersionID
			heads.PolicyDisabled = pol.Status == opsconfig.StatusDisabled
		}
	}
	return heads
}

func (s *Server) invalidateApprovalsForResource(ctx context.Context, scope isolation.Scope, resourceID, reason string) {
	if s.approvals == nil || strings.TrimSpace(resourceID) == "" {
		return
	}
	_, _ = s.approvals.InvalidateMatching(ctx, scope, approval.InvalidateInput{
		ResourceID: resourceID,
		Reason:     reason,
		Now:        s.clock().UTC(),
	})
	items, err := s.approvals.List(ctx, scope, approval.Filter{})
	if err != nil {
		return
	}
	for _, rec := range items {
		if rec.ExecutionID == "" || rec.Status != approval.StatusInvalidated {
			continue
		}
		if rec.TargetID == resourceID || rec.PolicyResourceID == resourceID {
			s.resumeApprovalWait(ctx, scope, rec, "expired")
		}
	}
}

func (s *Server) parkApprovalClaim(ctx context.Context, scope isolation.Scope, result wfstore.DispatchResult) (wfstore.DispatchResult, error) {
	if result.Step.NodeType != "flow.approval" || s.workflows == nil {
		return result, nil
	}
	eval, err := s.evaluateVersion(ctx, scope, result.Execution.WorkflowID, result.Execution.WorkflowVersionID)
	if err != nil {
		return result, err
	}
	var req *policy.Requirement
	expires := s.clock().UTC().Add(time.Hour)
	for i := range eval.Requirements {
		item := eval.Requirements[i]
		if item.NodeID == result.Step.NodeID && item.Wait {
			req = &eval.Requirements[i]
			if !item.ExpiresAt.IsZero() {
				expires = item.ExpiresAt
			}
			break
		}
	}
	waited, err := s.workflows.WaitJob(ctx, scope, s.clock().UTC(), wfstore.WaitJobInput{
		JobID:       result.Job.ID,
		AvailableAt: expires,
	})
	if err != nil {
		return result, err
	}
	if s.approvals != nil && req != nil {
		_, _ = s.approvals.Create(ctx, scope, approval.CreateInput{
			WorkflowID:        result.Execution.WorkflowID,
			WorkflowVersionID: result.Execution.WorkflowVersionID,
			WorkflowDigest:    result.Execution.WorkflowDigest,
			ExecutionID:       result.Execution.ID,
			RequestedBy:       result.Execution.RequestedBy,
			Requirement:       *req,
		})
	}
	waited.Recovered = result.Recovered
	return waited, nil
}

func (s *Server) syncWaitingApprovals(ctx context.Context, scope isolation.Scope) {
	if s.workflows == nil || s.approvals == nil {
		return
	}
	items, err := s.workflows.ListExecutions(ctx, scope, wfstore.ExecutionListFilter{Status: wfstore.ExecutionWaiting, Limit: 100})
	if err != nil {
		return
	}
	for _, exec := range items {
		steps, err := s.workflows.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			continue
		}
		eval, evalErr := s.evaluateVersion(ctx, scope, exec.WorkflowID, exec.WorkflowVersionID)
		if evalErr != nil {
			continue
		}
		for _, step := range steps {
			if step.NodeType != "flow.approval" || step.Status != wfstore.ExecutionWaiting {
				continue
			}
			for _, req := range eval.Requirements {
				if req.NodeID != step.NodeID || !req.Wait {
					continue
				}
				_, _ = s.approvals.Create(ctx, scope, approval.CreateInput{
					WorkflowID:        exec.WorkflowID,
					WorkflowVersionID: exec.WorkflowVersionID,
					WorkflowDigest:    exec.WorkflowDigest,
					ExecutionID:       exec.ID,
					RequestedBy:       exec.RequestedBy,
					Requirement:       req,
				})
			}
		}
	}
}

func (s *Server) resumeApprovalWait(ctx context.Context, scope isolation.Scope, rec approval.Record, port string) {
	if s.workflows == nil || strings.TrimSpace(rec.ExecutionID) == "" {
		return
	}
	jobs, err := s.workflows.ListJobs(ctx, scope, rec.ExecutionID)
	if err != nil {
		return
	}
	steps, err := s.workflows.ListSteps(ctx, scope, rec.ExecutionID)
	if err != nil {
		return
	}
	stepByID := map[string]wfstore.ExecutionStep{}
	for _, step := range steps {
		stepByID[step.ID] = step
	}
	for _, job := range jobs {
		step, ok := stepByID[job.ExecutionStepID]
		if !ok || step.NodeID != rec.NodeID {
			continue
		}
		if job.Status != wfstore.JobWaiting && job.Status != wfstore.JobSucceeded {
			continue
		}
		_, _ = s.workflows.ResumeWait(ctx, scope, s.clock().UTC(), wfstore.ResumeWaitInput{
			JobID: job.ID,
			Port:  port,
			Output: map[string]any{
				"approvalId": rec.ID,
				"status":     rec.Status,
			},
		})
		return
	}
}

func gateRequirements(reqs []policy.Requirement) []policy.Requirement {
	out := make([]policy.Requirement, 0, len(reqs))
	for _, req := range reqs {
		if req.Wait {
			continue
		}
		out = append(out, req)
	}
	return out
}

func (s *Server) dispatchApprovalsOK(ctx context.Context, scope isolation.Scope, eval policy.Result, workflowID, versionID string) ([]approval.Record, error) {
	reqs := gateRequirements(eval.Requirements)
	if eval.Decision == policy.DecisionAllow && len(reqs) == 0 {
		return []approval.Record{}, nil
	}
	if eval.Decision == policy.DecisionDeny {
		return nil, errPolicyDenied
	}
	if len(reqs) == 0 {
		return []approval.Record{}, nil
	}
	created, err := s.materializeRequirements(ctx, scope, workflowID, versionID, eval.WorkflowDigest, "", reqs)
	if err != nil {
		return nil, err
	}
	now := s.clock().UTC()
	for i, rec := range created {
		fresh := s.refreshRecord(ctx, scope, rec, now)
		created[i] = fresh
		if fresh.Status != approval.StatusApproved {
			return created, errApprovalRequired
		}
		if fresh.BindingFingerprint != approval.BindingFingerprint(scope.WorkspaceID(), versionID, eval.WorkflowDigest, rec.TargetVersionID, rec.PolicyVersionID, rec.PolicyDigest, rec.Operation, rec.NodeID) {
			return created, errApprovalRequired
		}
	}
	return created, nil
}

var (
	errPolicyDenied     = errors.New("policy denied")
	errApprovalRequired = errors.New("approval required")
)

func denyDetail(eval policy.Result) string {
	if len(eval.Denied) > 0 && eval.Denied[0].Reason != "" {
		return eval.Denied[0].Reason
	}
	return "Policy denied this dispatch."
}

func writeApprovalEvalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, wfstore.ErrNotFound), errors.Is(err, opsconfig.ErrNotFound), errors.Is(err, opsconfig.ErrCrossWorkspace):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, opsconfig.ErrDraftNotUsable), errors.Is(err, opsconfig.ErrNotPublished):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Only published revisions can be evaluated.")
	case errors.Is(err, opsconfig.ErrDisabled):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Resource is disabled.")
	case errors.Is(err, wfstore.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
	case errors.Is(err, opsconfig.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Operational configuration store is not available.")
	case errors.Is(err, wfstore.ErrInvalid), errors.Is(err, wfstore.ErrNoScope), errors.Is(err, opsconfig.ErrInvalid), errors.Is(err, opsconfig.ErrNoScope):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}

func writeApprovalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, approval.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, approval.ErrSelfApproval):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "The requester cannot approve or reject their own request.")
	case errors.Is(err, approval.ErrExpired):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Approval has expired.")
	case errors.Is(err, approval.ErrInvalidated):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Approval is bound to a previous workflow version, target, or policy revision.")
	case errors.Is(err, approval.ErrNotPending):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Approval is not pending.")
	case errors.Is(err, approval.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "An approval with this binding already exists.")
	case errors.Is(err, approval.ErrInvalid), errors.Is(err, approval.ErrNoScope):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, approval.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Approval store is not available.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
