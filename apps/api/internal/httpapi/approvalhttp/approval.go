package approvalhttp

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
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

type EvaluateResponse struct {
	policy.Result
	Approvals []approval.Record `json:"approvals"`
}

func requireApprovals(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.Approvals != nil {
		return true
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Approval store is not available.")
	return false
}

func approvalScope(s *core.Server, w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !requireApprovals(s, w, r) {
		return isolation.Scope{}, false
	}
	return s.RequireScope(w, r, user, perm)
}

func getApprovalCatalog(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if _, ok := approvalScope(s, w, r, authz.PermApprovalView); !ok {
		return
	}
	core.WriteJSON(w, http.StatusOK, approval.TypeCatalog())
}

func evaluatePolicy(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := approvalScope(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	var req evaluateRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	eval, records, err := evaluateAndList(s, r.Context(), scope, strings.TrimSpace(req.WorkflowID), strings.TrimSpace(req.WorkflowVersionID), "")
	if err != nil {
		WriteApprovalEvalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, EvaluateResponse{Result: eval, Approvals: records})
}

func listApprovals(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !requireApprovals(s, w, r) {
		return
	}
	ws, tenant, roles, _, ok := s.RequireAccess(w, r, user, authz.PermApprovalView)
	if !ok {
		return
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		core.WriteIdentityError(w, r, err)
		return
	}
	pageQuery, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	var next string
	pageQuery.Next = &next
	q := r.URL.Query()
	status := strings.TrimSpace(q.Get("status"))
	// Pending is the actionable inbox. The stored role and target are
	// enough after boot resync; this read does not re-evaluate policy.
	items, err := s.Approvals.List(r.Context(), scope, approval.Filter{
		Status:            status,
		WorkflowID:        strings.TrimSpace(q.Get("workflowId")),
		WorkflowVersionID: strings.TrimSpace(q.Get("workflowVersionId")),
		ExecutionID:       strings.TrimSpace(q.Get("executionId")),
		Page:              pageQuery,
		Actionable:        status == approval.StatusPending,
		ActorID:           user.ID,
		ActorRoles:        roles,
	})
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteApprovalError(w, r, err)
		return
	}
	now := s.Clock().UTC()
	out := make([]approval.Record, 0, len(items))
	for _, rec := range items {
		rec = refreshRecord(s, r.Context(), scope, rec, now)
		out = append(out, rec)
	}
	core.WritePage(w, out, pageQuery, next)
}

func createApprovals(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := approvalScope(s, w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req createApprovalsRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	eval, err := EvaluateVersion(s, r.Context(), scope, strings.TrimSpace(req.WorkflowID), strings.TrimSpace(req.WorkflowVersionID))
	if err != nil {
		WriteApprovalEvalError(w, r, err)
		return
	}
	if eval.Decision == policy.DecisionDeny {
		core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", DenyDetail(eval))
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
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "No approval requirement exists for that node.")
			return
		}
	}
	created, err := materializeRequirements(s, r.Context(), scope, strings.TrimSpace(req.WorkflowID), strings.TrimSpace(req.WorkflowVersionID), eval.WorkflowDigest, strings.TrimSpace(req.ExecutionID), reqs)
	if err != nil {
		WriteApprovalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, core.ListResponse[approval.Record]{Items: created})
}

func getApproval(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if reservedApprovalCollection(r.PathValue("approvalId")) {
		core.WriteProblem(w, r, http.StatusMethodNotAllowed, core.CodeMethodNotAllowed, "Method Not Allowed", "The "+r.Method+" method is not allowed for this path.")
		return
	}
	scope, ok := approvalScope(s, w, r, authz.PermApprovalView)
	if !ok {
		return
	}
	rec, err := s.Approvals.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("approvalId")))
	if err != nil {
		WriteApprovalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, refreshRecord(s, r.Context(), scope, rec, s.Clock().UTC()))
}

func decideApproval(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !requireApprovals(s, w, r) {
		return
	}
	// Fresh server-side authorization at decision time — do not reuse a cached grant.
	ws, _, roles, _, ok := s.RequireAccess(w, r, user, authz.PermApprovalDecide)
	if !ok {
		return
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, ws.TenantID, ws.WorkbenchKey)
	if err != nil {
		core.WriteIdentityError(w, r, err)
		return
	}
	var req decideApprovalRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	rec, err := s.Approvals.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("approvalId")))
	if err != nil {
		WriteApprovalError(w, r, err)
		return
	}
	if strings.TrimSpace(rec.ExecutionID) != "" && s.Workflows != nil {
		if err := s.Workflows.AbandonIfWorkflowDeleted(r.Context(), scope, s.Clock().UTC(), rec.ExecutionID); err != nil {
			if errors.Is(err, wfstore.ErrWorkflowDeleted) {
				// The stop closed pending approvals in that transaction on
				// Postgres. Memory has no shared transaction, so close here
				// too. A second close is a no-op once the row is canceled.
				if s.Approvals != nil {
					if closeErr := s.Approvals.ClosePendingForExecution(r.Context(), scope, rec.ExecutionID, approval.ReasonWorkflowDeleted, s.Clock().UTC()); closeErr != nil {
						core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
						return
					}
				}
				WriteApprovalError(w, r, approval.ErrClosed)
				return
			}
			if errors.Is(err, wfstore.ErrNotFound) {
				core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
				return
			}
			core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
			return
		}
	}
	derived, err := approval.ResolveGateRequirement(r.Context(), scope, s.Workflows, s.Ops, rec.WorkflowID, rec.WorkflowVersionID, rec.NodeID, s.Clock().UTC())
	if err != nil {
		core.WriteForbidden(w, r)
		return
	}
	projected, _ := approval.ProjectRequirement(rec, scope.WorkspaceID(), derived)
	heads := headsFor(s, r.Context(), scope, projected)
	out, err := s.Approvals.Decide(r.Context(), scope, rec.ID, approval.DecideInput{
		Decision: req.Decision,
		Note:     req.Note,
		Now:      s.Clock().UTC(),
		Heads:    heads,
		Roles:    roles,
		Resolve: func(ctx context.Context, scope isolation.Scope, row approval.Record) (policy.Requirement, error) {
			return approval.ResolveGateRequirement(ctx, scope, s.Workflows, s.Ops, row.WorkflowID, row.WorkflowVersionID, row.NodeID, s.Clock().UTC())
		},
	})
	if err != nil {
		WriteApprovalError(w, r, err)
		return
	}
	if err := resumeApprovalWait(s, r.Context(), scope, out, out.Status); errors.Is(err, wfstore.ErrWorkflowDeleted) {
		core.WriteProblem(w, r, http.StatusConflict, core.CodeWorkflowDeleted, "Conflict", "This workflow was deleted. The run will not continue.")
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

func listApprovalEvents(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := approvalScope(s, w, r, authz.PermApprovalView)
	if !ok {
		return
	}
	items, err := s.Approvals.Events(r.Context(), scope, strings.TrimSpace(r.PathValue("approvalId")))
	if err != nil {
		WriteApprovalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.ListResponse[approval.Event]{Items: items})
}

func reservedApprovalCollection(id string) bool {
	return strings.TrimSpace(id) == "catalog"
}

func EvaluateVersion(s *core.Server, ctx context.Context, scope isolation.Scope, workflowID, versionID string) (policy.Result, error) {
	if s.Workflows == nil {
		return policy.Result{}, wfstore.ErrStoreUnavailable
	}
	ver, err := s.Workflows.GetVersion(ctx, scope, workflowID, versionID)
	if err != nil {
		return policy.Result{}, err
	}
	pins, err := approval.ResolvePins(ctx, scope, s.Ops, ver.DefinitionYAML)
	if err != nil {
		return policy.Result{}, err
	}
	return policy.Evaluate(policy.Input{
		YAML:              ver.DefinitionYAML,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Pins:              pins,
		Now:               s.Clock().UTC(),
	})
}

func ResolveEvalPins(s *core.Server, ctx context.Context, scope isolation.Scope, yamlDoc string) ([]opsconfig.Pin, error) {
	return approval.ResolvePins(ctx, scope, s.Ops, yamlDoc)
}

func evaluateAndList(s *core.Server, ctx context.Context, scope isolation.Scope, workflowID, versionID, executionID string) (policy.Result, []approval.Record, error) {
	eval, err := EvaluateVersion(s, ctx, scope, workflowID, versionID)
	if err != nil {
		return policy.Result{}, nil, err
	}
	if s.Approvals == nil {
		return eval, []approval.Record{}, nil
	}
	items, err := s.Approvals.List(ctx, scope, approval.Filter{WorkflowVersionID: versionID, ExecutionID: executionID})
	if err != nil {
		return eval, nil, err
	}
	now := s.Clock().UTC()
	out := make([]approval.Record, 0, len(items))
	for _, rec := range items {
		out = append(out, refreshRecord(s, ctx, scope, rec, now))
	}
	return eval, out, nil
}

func materializeRequirements(s *core.Server, ctx context.Context, scope isolation.Scope, workflowID, versionID, digest, executionID string, reqs []policy.Requirement) ([]approval.Record, error) {
	out := make([]approval.Record, 0, len(reqs))
	for _, req := range reqs {
		rec, err := s.Approvals.Create(ctx, scope, approval.CreateInput{
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

func refreshRecord(s *core.Server, ctx context.Context, scope isolation.Scope, rec approval.Record, now time.Time) approval.Record {
	if s.Approvals == nil {
		return rec
	}
	heads := headsFor(s, ctx, scope, rec)
	out, err := s.Approvals.Refresh(ctx, scope, rec.ID, heads, now)
	if err != nil {
		return rec
	}
	if rec.ExecutionID != "" && rec.Status == approval.StatusPending &&
		(out.Status == approval.StatusExpired || out.Status == approval.StatusInvalidated) {
		_ = resumeApprovalWait(s, ctx, scope, out, "expired")
	}
	return out
}

func headsFor(s *core.Server, ctx context.Context, scope isolation.Scope, rec approval.Record) approval.CurrentHeads {
	heads := approval.CurrentHeads{WorkflowDigest: rec.WorkflowDigest}
	if s.Workflows != nil && rec.WorkflowID != "" && rec.WorkflowVersionID != "" {
		if ver, err := s.Workflows.GetVersion(ctx, scope, rec.WorkflowID, rec.WorkflowVersionID); err == nil {
			heads.WorkflowDigest = ver.Digest
		}
	}
	if s.Ops == nil {
		return heads
	}
	if rec.TargetID != "" && rec.TargetKind != "" {
		if target, err := s.Ops.Get(ctx, scope, rec.TargetKind, rec.TargetID); err == nil {
			heads.TargetLatestVersionID = target.LatestVersionID
			heads.TargetDisabled = target.Status == opsconfig.StatusDisabled
		}
	}
	if rec.PolicyResourceID != "" {
		if pol, err := s.Ops.Get(ctx, scope, opsconfig.KindPolicy, rec.PolicyResourceID); err == nil {
			heads.PolicyLatestVersionID = pol.LatestVersionID
			heads.PolicyDisabled = pol.Status == opsconfig.StatusDisabled
		}
	}
	return heads
}

func InvalidateApprovalsForResource(s *core.Server, ctx context.Context, scope isolation.Scope, resourceID, reason string) {
	if s.Approvals == nil || strings.TrimSpace(resourceID) == "" {
		return
	}
	_, _ = s.Approvals.InvalidateMatching(ctx, scope, approval.InvalidateInput{
		ResourceID: resourceID,
		Reason:     reason,
		Now:        s.Clock().UTC(),
	})
	items, err := s.Approvals.List(ctx, scope, approval.Filter{})
	if err != nil {
		return
	}
	for _, rec := range items {
		if rec.ExecutionID == "" || rec.Status != approval.StatusInvalidated {
			continue
		}
		if rec.TargetID == resourceID || rec.PolicyResourceID == resourceID {
			_ = resumeApprovalWait(s, ctx, scope, rec, "expired")
		}
	}
}

func parkedApprovalInput(in *approval.CreateInput) *wfstore.ParkedApproval {
	if in == nil {
		return nil
	}
	req := in.Requirement
	return &wfstore.ParkedApproval{
		WorkflowID:        in.WorkflowID,
		WorkflowVersionID: in.WorkflowVersionID,
		WorkflowDigest:    in.WorkflowDigest,
		ExecutionID:       in.ExecutionID,
		RequestedBy:       in.RequestedBy,
		NodeID:            req.NodeID,
		NodeName:          req.NodeName,
		Operation:         req.Operation,
		ApproverRole:      req.ApproverRole,
		TargetKind:        req.TargetKind,
		TargetID:          req.TargetID,
		TargetVersionID:   req.TargetVersionID,
		TargetDigest:      req.TargetDigest,
		PolicyResourceID:  req.PolicyResourceID,
		PolicyVersionID:   req.PolicyVersionID,
		PolicyDigest:      req.PolicyDigest,
		PolicyRevision:    req.PolicyRevision,
	}
}

func ParkApprovalClaim(s *core.Server, ctx context.Context, scope isolation.Scope, result wfstore.DispatchResult) (wfstore.DispatchResult, error) {
	if result.Step.NodeType != "flow.approval" || s.Workflows == nil {
		return result, nil
	}
	req, err := approval.ResolveGateRequirement(ctx, scope, s.Workflows, s.Ops, result.Execution.WorkflowID, result.Execution.WorkflowVersionID, result.Step.NodeID, s.Clock().UTC())
	if err != nil {
		return result, err
	}
	expires := req.ExpiresAt
	if expires.IsZero() {
		expires = s.Clock().UTC().Add(time.Hour)
	}
	req.ExpiresAt = expires
	seed := &approval.CreateInput{
		WorkflowID:        result.Execution.WorkflowID,
		WorkflowVersionID: result.Execution.WorkflowVersionID,
		WorkflowDigest:    result.Execution.WorkflowDigest,
		ExecutionID:       result.Execution.ID,
		RequestedBy:       result.Execution.RequestedBy,
		Requirement:       req,
	}
	waited, err := s.Workflows.WaitJob(ctx, scope, s.Clock().UTC(), wfstore.WaitJobInput{
		JobID:       result.Job.ID,
		AvailableAt: expires,
		Approval:    parkedApprovalInput(seed),
	})
	if err != nil {
		return result, err
	}
	// Memory has no shared transaction with the approval table. Postgres
	// inserts the row inside WaitJob and copies expires_at from the deadline.
	if _, mem := s.Workflows.(*wfstore.Memory); mem && s.Approvals != nil && seed != nil {
		_, _ = s.Approvals.Create(ctx, scope, *seed)
	}
	waited.Recovered = result.Recovered
	return waited, nil
}

func SyncWaitingApprovals(s *core.Server, ctx context.Context, scope isolation.Scope) {
	if s.Workflows == nil || s.Approvals == nil {
		return
	}
	items, err := s.Workflows.ListExecutions(ctx, scope, wfstore.ExecutionListFilter{Status: wfstore.ExecutionWaiting, Limit: 100})
	if err != nil {
		return
	}
	for _, exec := range items {
		steps, err := s.Workflows.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			continue
		}
		eval, evalErr := EvaluateVersion(s, ctx, scope, exec.WorkflowID, exec.WorkflowVersionID)
		if evalErr != nil {
			continue
		}
		jobs, jobErr := s.Workflows.ListJobs(ctx, scope, exec.ID)
		if jobErr != nil {
			continue
		}
		deadlineByStep := map[string]time.Time{}
		for _, job := range jobs {
			if job.Status == wfstore.JobWaiting && !job.AvailableAt.IsZero() {
				deadlineByStep[job.ExecutionStepID] = job.AvailableAt
			}
		}
		for _, step := range steps {
			if step.NodeType != "flow.approval" || step.Status != wfstore.ExecutionWaiting {
				continue
			}
			for _, req := range eval.Requirements {
				if req.NodeID != step.NodeID || !req.Wait {
					continue
				}
				if deadline, ok := deadlineByStep[step.ID]; ok {
					req.ExpiresAt = deadline
				}
				_, _ = s.Approvals.Create(ctx, scope, approval.CreateInput{
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

func resumeApprovalWait(s *core.Server, ctx context.Context, scope isolation.Scope, rec approval.Record, port string) error {
	if s.Workflows == nil || strings.TrimSpace(rec.ExecutionID) == "" {
		return nil
	}
	jobs, err := s.Workflows.ListJobs(ctx, scope, rec.ExecutionID)
	if err != nil {
		return err
	}
	steps, err := s.Workflows.ListSteps(ctx, scope, rec.ExecutionID)
	if err != nil {
		return err
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
		_, err = s.Workflows.ResumeWait(ctx, scope, s.Clock().UTC(), wfstore.ResumeWaitInput{
			JobID: job.ID,
			Port:  port,
			Output: map[string]any{
				"approvalId": rec.ID,
				"status":     rec.Status,
			},
		})
		return err
	}
	return nil
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

func DispatchApprovalsOK(s *core.Server, ctx context.Context, scope isolation.Scope, eval policy.Result, workflowID, versionID string) ([]approval.Record, error) {
	reqs := gateRequirements(eval.Requirements)
	if eval.Decision == policy.DecisionAllow && len(reqs) == 0 {
		return []approval.Record{}, nil
	}
	if eval.Decision == policy.DecisionDeny {
		return nil, ErrPolicyDenied
	}
	if len(reqs) == 0 {
		return []approval.Record{}, nil
	}
	created, err := materializeRequirements(s, ctx, scope, workflowID, versionID, eval.WorkflowDigest, "", reqs)
	if err != nil {
		return nil, err
	}
	now := s.Clock().UTC()
	for i, rec := range created {
		fresh := refreshRecord(s, ctx, scope, rec, now)
		created[i] = fresh
		if fresh.Status != approval.StatusApproved {
			return created, ErrApprovalRequired
		}
		if fresh.BindingFingerprint != approval.BindingFingerprint(scope.WorkspaceID(), versionID, eval.WorkflowDigest, rec.TargetVersionID, rec.PolicyVersionID, rec.PolicyDigest, rec.Operation, rec.NodeID, rec.ApproverRole, rec.ExecutionID, rec.ApproverUserID, rec.ApproverGroupID) {
			return created, ErrApprovalRequired
		}
	}
	return created, nil
}

var (
	ErrPolicyDenied     = errors.New("policy denied")
	ErrApprovalRequired = errors.New("approval required")
)

func DenyDetail(eval policy.Result) string {
	if len(eval.Denied) > 0 && eval.Denied[0].Reason != "" {
		return eval.Denied[0].Reason
	}
	return "Policy denied this dispatch."
}

func WriteApprovalEvalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, approval.ErrBindingUnresolved):
		core.WriteForbidden(w, r)
	case errors.Is(err, wfstore.ErrNotFound), errors.Is(err, opsconfig.ErrNotFound), errors.Is(err, opsconfig.ErrCrossWorkspace):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, opsconfig.ErrDraftNotUsable), errors.Is(err, opsconfig.ErrNotPublished):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Only published revisions can be evaluated.")
	case errors.Is(err, opsconfig.ErrDisabled):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Resource is disabled.")
	case errors.Is(err, wfstore.ErrStoreUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
	case errors.Is(err, opsconfig.ErrStoreUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Operational configuration store is not available.")
	case errors.Is(err, wfstore.ErrInvalid), errors.Is(err, wfstore.ErrNoScope), errors.Is(err, opsconfig.ErrInvalid), errors.Is(err, opsconfig.ErrNoScope):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	default:
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}

func WriteApprovalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, approval.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, approval.ErrSelfApproval):
		core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", "The requester cannot approve or reject their own request.")
	case errors.Is(err, approval.ErrForbidden), errors.Is(err, approval.ErrBindingUnresolved):
		core.WriteForbidden(w, r)
	case errors.Is(err, approval.ErrExpired):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Approval has expired.")
	case errors.Is(err, approval.ErrInvalidated):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Approval is bound to a previous workflow version, target, or policy revision.")
	case errors.Is(err, approval.ErrClosed):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeApprovalClosed, "Conflict", "This approval is closed and can no longer be decided.")
	case errors.Is(err, approval.ErrNotPending):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Approval is not pending.")
	case errors.Is(err, approval.ErrConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "An approval with this binding already exists.")
	case errors.Is(err, approval.ErrInvalid), errors.Is(err, approval.ErrNoScope):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, approval.ErrStoreUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Approval store is not available.")
	default:
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
