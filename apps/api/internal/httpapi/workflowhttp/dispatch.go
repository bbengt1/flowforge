package workflowhttp

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	ssheng "github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type claimJobRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	WorkerID       string `json:"workerId"`
	LeaseSeconds   int    `json:"leaseSeconds"`
}

type jobActionRequest struct {
	ID             string         `json:"id"`
	WorkspaceID    string         `json:"workspace_id"`
	WorkspaceIDAlt string         `json:"workspaceId"`
	JobToken       string         `json:"jobToken"`
	WorkerID       string         `json:"workerId"`
	FencingToken   int64          `json:"fencingToken"`
	LeaseSeconds   int            `json:"leaseSeconds"`
	Output         map[string]any `json:"output"`
	Error          map[string]any `json:"error"`
}

type retryStepRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	StepID         string `json:"stepId"`
}

type ClaimJobResponse struct {
	Claimed   bool                  `json:"claimed"`
	JobToken  string                `json:"jobToken,omitempty"`
	Binding   wfstore.JobBinding    `json:"binding,omitempty"`
	Job       wfstore.ExecutionJob  `json:"job"`
	Step      wfstore.ExecutionStep `json:"step"`
	Execution wfstore.Execution     `json:"execution"`
	Recovered int                   `json:"recovered,omitempty"`
}

type dispatchJobResponse struct {
	Job       wfstore.ExecutionJob  `json:"job"`
	Step      wfstore.ExecutionStep `json:"step"`
	Execution wfstore.Execution     `json:"execution"`
}

type RecoverJobsResponse struct {
	Recovered int `json:"recovered"`
}

type RetryResponse struct {
	Execution wfstore.Execution     `json:"execution"`
	Step      wfstore.ExecutionStep `json:"step"`
	Job       wfstore.ExecutionJob  `json:"job"`
}

func claimJob(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req claimJobRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	result, err := s.Workflows.ClaimJob(r.Context(), scope, Now(s), wfstore.ClaimInput{
		WorkerID: strings.TrimSpace(req.WorkerID),
		Lease:    secondsDuration(req.LeaseSeconds),
	})
	if errors.Is(err, wfstore.ErrEmptyClaim) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		observability.NoteLeaseClaim(r.Context(), "error", 0)
		WriteWorkflowStoreError(w, r, err)
		return
	}
	jobCtx, span := observability.Continue(r.Context(), result.Job.TraceParent, result.Job.TraceState, "job.claim")
	defer span.End()
	observability.PublishResponseTrace(r.Context(), jobCtx, w.Header())
	if err := wfstore.AuthorizeJobBinding(result.Binding, scope.WorkspaceID(), result.Execution.WorkflowVersionID, result.Execution.WorkflowDigest, Now(s)); err != nil {
		s.EmitSecurityError(r, scope, err)
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if parked, parkErr := approvalhttp.ParkApprovalClaim(s, r.Context(), scope, result); parkErr != nil {
		approvalhttp.WriteApprovalEvalError(w, r, parkErr)
		return
	} else {
		result = parked
	}
	if result.Job.Status == wfstore.JobWaiting {
		core.WriteJSON(w, http.StatusOK, ClaimJobResponse{
			Claimed:   true,
			Binding:   result.Binding,
			Job:       result.Job,
			Step:      result.Step,
			Execution: result.Execution,
			Recovered: result.Recovered,
		})
		return
	}
	if err := revalidateScriptDispatch(s, r, scope, result); err != nil {
		fail := map[string]any{"code": scripts.CodeArtifactRevoked, "message": "Revoked or unverified script artifacts cannot be executed."}
		if ee := scriptEngineError(err); ee != nil {
			fail["code"] = ee.Code
			fail["message"] = ee.Message
		}
		_, _ = s.Workflows.FailJob(r.Context(), scope, Now(s), wfstore.JobActionInput{
			JobID:        result.Job.ID,
			WorkerID:     result.Job.WorkerID,
			FencingToken: result.Job.FencingToken,
			Error:        fail,
		})
		writeScriptError(w, r, err)
		return
	}
	token, err := wfstore.SignJobTicket(s.JobKey, result.Binding)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, ClaimJobResponse{
		Claimed:   true,
		JobToken:  token,
		Binding:   result.Binding,
		Job:       result.Job,
		Step:      result.Step,
		Execution: result.Execution,
		Recovered: result.Recovered,
	})
}

func recoverJobs(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	n, err := recoverWorkspace(s, r.Context(), scope)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, RecoverJobsResponse{Recovered: n})
}

func heartbeatJob(s *core.Server, w http.ResponseWriter, r *http.Request) {
	workerJobAction(s, w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		job, err := s.Workflows.GetJob(r.Context(), scope, in.JobID)
		if err != nil {
			return wfstore.DispatchResult{}, err
		}
		if job.Status != wfstore.JobRunning && job.HeartbeatAt == nil {
			step, stepErr := s.Workflows.GetStep(r.Context(), scope, job.ExecutionID, job.ExecutionStepID)
			if stepErr != nil {
				return wfstore.DispatchResult{}, stepErr
			}
			exec, execErr := s.Workflows.GetExecutionByID(r.Context(), scope, job.ExecutionID)
			if execErr != nil {
				return wfstore.DispatchResult{}, execErr
			}
			if err := revalidateScriptDispatch(s, r, scope, wfstore.DispatchResult{Execution: exec, Step: step, Job: job}); err != nil {
				fail := map[string]any{"code": scripts.CodeArtifactRevoked, "message": "Revoked or unverified script artifacts cannot be executed."}
				if ee := scriptEngineError(err); ee != nil {
					fail["code"] = ee.Code
					fail["message"] = ee.Message
				}
				_, _ = s.Workflows.FailJob(r.Context(), scope, Now(s), wfstore.JobActionInput{
					JobID:        job.ID,
					WorkerID:     in.WorkerID,
					FencingToken: in.FencingToken,
					Error:        fail,
				})
				return wfstore.DispatchResult{}, err
			}
		}
		return s.Workflows.HeartbeatJob(r.Context(), scope, Now(s), in)
	})
}

func releaseJob(s *core.Server, w http.ResponseWriter, r *http.Request) {
	workerJobAction(s, w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		return s.Workflows.ReleaseJob(r.Context(), scope, Now(s), in)
	})
}

func completeJob(s *core.Server, w http.ResponseWriter, r *http.Request) {
	workerJobAction(s, w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		return s.Workflows.CompleteJob(r.Context(), scope, Now(s), in)
	})
}

func failJob(s *core.Server, w http.ResponseWriter, r *http.Request) {
	workerJobAction(s, w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		return s.Workflows.FailJob(r.Context(), scope, Now(s), in)
	})
}

func workerJobAction(s *core.Server, w http.ResponseWriter, r *http.Request, fn func(isolation.Scope, wfstore.JobActionInput) (wfstore.DispatchResult, error)) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req jobActionRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	binding, err := wfstore.ParseJobTicket(s.JobKey, req.JobToken)
	if err != nil {
		s.EmitSecurityError(r, scope, err)
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if binding.JobID != jobID || binding.WorkspaceID != scope.WorkspaceID() {
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	if err := wfstore.AuthorizeJobBinding(binding, scope.WorkspaceID(), "", "", Now(s)); err != nil {
		s.EmitSecurityError(r, scope, err)
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if req.FencingToken != 0 && req.FencingToken != binding.FencingToken {
		WriteWorkflowStoreError(w, r, wfstore.ErrFenceConflict)
		return
	}
	result, err := fn(scope, wfstore.JobActionInput{
		JobID:        jobID,
		WorkerID:     strings.TrimSpace(req.WorkerID),
		FencingToken: binding.FencingToken,
		Lease:        secondsDuration(req.LeaseSeconds),
		Output:       req.Output,
		Error:        req.Error,
	})
	if err != nil {
		var ee *scripts.EngineError
		if errors.As(err, &ee) || errors.Is(err, scripts.ErrRevoked) || errors.Is(err, scripts.ErrMutable) || errors.Is(err, scripts.ErrUnscanned) || errors.Is(err, scripts.ErrUnsigned) || errors.Is(err, scripts.ErrScanFailed) {
			writeScriptError(w, r, err)
			return
		}
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if strings.TrimSpace(r.Header.Get(observability.TraceParentHeader)) == "" && result.Job.TraceParent != "" {
		jobCtx, span := observability.Continue(r.Context(), result.Job.TraceParent, result.Job.TraceState, "job.action")
		defer span.End()
		observability.PublishResponseTrace(r.Context(), jobCtx, w.Header())
	}
	core.WriteJSON(w, http.StatusOK, dispatchJobResponse{Job: result.Job, Step: result.Step, Execution: result.Execution})
}

type emergencyStopRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	StepID         string `json:"stepId"`
	Uncertain      bool   `json:"uncertain"`
}

func emergencyStopExecution(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermScriptEmergencyStop)
	if !ok {
		return
	}
	var req emergencyStopRequest
	if r.ContentLength > 0 {
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	stepID := strings.TrimSpace(core.FirstNonEmpty(r.PathValue("stepId"), req.StepID))
	exec, err := s.Workflows.GetExecutionByID(r.Context(), scope, executionID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if !authorizeScriptEmergencyStop(s, w, r, scope, exec, stepID) {
		return
	}
	result, err := s.Workflows.EmergencyStop(r.Context(), scope, Now(s), wfstore.EmergencyStopInput{
		ExecutionID: executionID,
		StepID:      stepID,
		Uncertain:   req.Uncertain,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	WriteExecutionDetail(s, w, r, scope, result.Execution, http.StatusOK)
}

func authorizeScriptEmergencyStop(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, exec wfstore.Execution, stepID string) bool {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return false
	}
	_, _, _, perms, ok := s.RequireAccess(w, r, user, authz.PermScriptEmergencyStop)
	if !ok {
		return false
	}
	steps, err := s.Workflows.ListSteps(r.Context(), scope, exec.ID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return false
	}
	checked := false
	for _, step := range steps {
		if stepID != "" && step.ID != stepID {
			continue
		}
		if !scripts.IsScriptNode(step.NodeType) {
			continue
		}
		if err := scripts.AuthorizeEmergencyStop(perms, scriptNodePolicySpec(s, r.Context(), scope, exec, step)); err != nil {
			writeScriptError(w, r, err)
			return false
		}
		checked = true
		if stepID != "" {
			return true
		}
	}
	if !checked {
		if err := scripts.AuthorizeEmergencyStop(perms, nil); err != nil {
			writeScriptError(w, r, err)
			return false
		}
	}
	return true
}

func scriptNodePolicySpec(s *core.Server, ctx context.Context, scope isolation.Scope, exec wfstore.Execution, step wfstore.ExecutionStep) map[string]any {
	if s.Ops == nil || s.Workflows == nil {
		return nil
	}
	ver, err := s.Workflows.GetVersion(ctx, scope, exec.WorkflowID, exec.WorkflowVersionID)
	if err != nil {
		return nil
	}
	pins, err := approvalhttp.ResolveEvalPins(s, ctx, scope, ver.DefinitionYAML)
	if err != nil {
		return nil
	}
	res, errs := workflow.ParseAndNormalize([]byte(ver.DefinitionYAML))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return nil
	}
	var policyID string
	for _, node := range res.Document.Spec.Nodes {
		if node.ID == step.NodeID && scripts.IsScriptNode(node.Type) {
			policyID, _ = node.With["policyId"].(string)
			break
		}
	}
	policyID = strings.TrimSpace(policyID)
	if policyID == "" {
		return nil
	}
	for _, pin := range pins {
		if pin.Kind == opsconfig.KindPolicy && pin.ResourceID == policyID {
			return pin.Spec
		}
	}
	return nil
}

func revalidateScriptDispatch(s *core.Server, r *http.Request, scope isolation.Scope, result wfstore.DispatchResult) error {
	if s.Scripts == nil || !scripts.IsScriptNode(result.Step.NodeType) {
		return nil
	}
	ver, err := s.Workflows.GetVersion(r.Context(), scope, result.Execution.WorkflowID, result.Execution.WorkflowVersionID)
	if err != nil {
		return err
	}
	nodes := scriptNodeSpecs(ver.DefinitionYAML)
	return s.Scripts.VerifyNodePins(r.Context(), scope, ver.ID, nodes)
}

func cancelExecution(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionCancel)
	if !ok {
		return
	}
	if r.ContentLength > 0 {
		var req retryStepRequest
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	exec, err := s.Workflows.CancelExecution(r.Context(), scope, Now(s), strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	WriteExecutionDetail(s, w, r, scope, exec, http.StatusOK)
}

func retryExecution(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req retryStepRequest
	if r.ContentLength > 0 {
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	stepID := strings.TrimSpace(core.FirstNonEmpty(r.PathValue("stepId"), req.StepID))
	if stepID == "" {
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
		stepID = LatestRetryCandidate(steps)
		if stepID == "" {
			if exec.Capabilities != nil {
				writeRetryCapability(w, r, exec.Capabilities.Retry)
				return
			}
			WriteWorkflowStoreError(w, r, wfstore.ErrRetryNotAllowed)
			return
		}
	}
	hint := retryHint(s, r.Context(), scope, executionID, stepID)
	result, err := s.Workflows.RetryStep(r.Context(), scope, Now(s), executionID, stepID, hint)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	annotateRetryResult(s, r, scope, &result)
	core.WriteJSON(w, http.StatusCreated, RetryResponse{Execution: result.Execution, Step: result.Step, Job: result.Job})
}

func writeRetryCapability(w http.ResponseWriter, r *http.Request, cap wfstore.RetryCapability) {
	switch cap.Code {
	case wfstore.CodeStepAttemptSuperseded:
		core.WriteProblem(w, r, http.StatusConflict, core.CodeStepAttemptSuperseded, "Conflict", "This step attempt was superseded by a later attempt.")
	case wfstore.CodeRetryDenied:
		core.WriteProblem(w, r, http.StatusConflict, core.CodeRetryDenied, "Retry Denied", "Retry is not allowed: default maxAttempts is 0, the node is not retrySafe, verification or idempotency key is missing, or no attempts remain. Indeterminate SSH/script steps are never blindly re-run.")
	default:
		core.WriteProblemReason(w, r, http.StatusConflict, core.CodeExecutionNotRetryable, "Conflict", "This execution cannot be retried.", cap.Reason)
	}
}

func annotateRetryResult(s *core.Server, r *http.Request, scope isolation.Scope, result *wfstore.RetryResult) {
	if s.Workflows == nil || result == nil {
		return
	}
	steps, err := s.Workflows.ListSteps(r.Context(), scope, result.Execution.ID)
	if err != nil {
		return
	}
	exec := result.Execution
	if err := s.Workflows.AnnotateRetryCapabilities(r.Context(), scope, &exec, steps); err != nil {
		return
	}
	result.Execution = exec
	for _, step := range steps {
		if step.ID == result.Step.ID {
			result.Step.Capabilities = step.Capabilities
			return
		}
	}
}

func retryHint(s *core.Server, ctx context.Context, scope isolation.Scope, executionID, stepID string) map[string]any {
	if hint := sshRetryHint(s, ctx, scope, executionID, stepID); hint != nil {
		return hint
	}
	return scriptRetryHint(s, ctx, scope, executionID, stepID)
}

func scriptRetryHint(s *core.Server, ctx context.Context, scope isolation.Scope, executionID, stepID string) map[string]any {
	if s.Workflows == nil {
		return nil
	}
	step, err := s.Workflows.GetStep(ctx, scope, executionID, stepID)
	if err != nil || !scripts.IsScriptNode(step.NodeType) {
		return nil
	}
	exec, err := s.Workflows.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		return nil
	}
	ver, err := s.Workflows.GetVersion(ctx, scope, exec.WorkflowID, exec.WorkflowVersionID)
	if err != nil {
		return nil
	}
	res, errs := workflow.ParseAndNormalize([]byte(ver.DefinitionYAML))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return nil
	}
	for _, node := range res.Document.Spec.Nodes {
		if node.ID != step.NodeID || !scripts.IsScriptNode(node.Type) {
			continue
		}
		decl, err := scripts.RetryDeclarationFromWith(node.With)
		if err != nil {
			return nil
		}
		return map[string]any{
			"retrySafe":              decl.RetrySafe,
			"verificationDeclared":   decl.Verification != nil,
			"idempotencyKey":         decl.IdempotencyKey,
			"idempotencyKeyDeclared": decl.IdempotencyKey != "",
			"maxAttempts":            scripts.MaxAttemptsFromWith(node.With),
		}
	}
	return nil
}

func sshRetryHint(s *core.Server, ctx context.Context, scope isolation.Scope, executionID, stepID string) map[string]any {
	if s.Ops == nil || s.Workflows == nil {
		return nil
	}
	step, err := s.Workflows.GetStep(ctx, scope, executionID, stepID)
	if err != nil || step.NodeType != ssheng.NodeSSHRun {
		return nil
	}
	exec, err := s.Workflows.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		return nil
	}
	ver, err := s.Workflows.GetVersion(ctx, scope, exec.WorkflowID, exec.WorkflowVersionID)
	if err != nil {
		return nil
	}
	pins, err := s.Ops.ListPins(ctx, scope, opsconfig.OwnerExecution, executionID)
	if err != nil || len(pins) == 0 {
		pins, err = s.Ops.ListPins(ctx, scope, opsconfig.OwnerWorkflowVersion, exec.WorkflowVersionID)
		if err != nil {
			return nil
		}
	}
	res, errs := workflow.ParseAndNormalize([]byte(ver.DefinitionYAML))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return nil
	}
	var profileID string
	for _, node := range res.Document.Spec.Nodes {
		if node.ID == step.NodeID && node.Type == ssheng.NodeSSHRun {
			profileID, _ = node.With["commandProfileId"].(string)
			break
		}
	}
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return nil
	}
	for _, pin := range pins {
		if pin.Kind == opsconfig.KindCommandProfile && pin.ResourceID == profileID {
			retrySafe, _ := pin.Spec["retrySafe"].(bool)
			_, hasVerify := pin.Spec["verification"].(map[string]any)
			return map[string]any{
				"retrySafe":            retrySafe,
				"verificationDeclared": hasVerify,
				"maxAttempts":          ssheng.MaxAttemptsFromWith(step.Input),
			}
		}
	}
	return nil
}

func Now(s *core.Server) time.Time {
	if s.Clock != nil {
		return s.Clock().UTC()
	}
	return time.Now().UTC()
}

func secondsDuration(n int) time.Duration {
	if n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Second
}

// LatestRetryCandidate picks the newest step whose capabilities.retry.allowed
// is true. Callers annotate with the shared eligibility function first.
func LatestRetryCandidate(steps []wfstore.ExecutionStep) string {
	var best *wfstore.ExecutionStep
	for i := range steps {
		cap := steps[i].Capabilities
		if cap == nil || !cap.Retry.Allowed {
			continue
		}
		if best == nil || steps[i].Attempt > best.Attempt || (steps[i].Attempt == best.Attempt && steps[i].UpdatedAt.After(best.UpdatedAt)) {
			chosen := steps[i]
			best = &chosen
		}
	}
	if best == nil {
		return ""
	}
	return best.ID
}
