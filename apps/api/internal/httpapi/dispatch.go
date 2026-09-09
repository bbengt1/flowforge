package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
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

type claimJobResponse struct {
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

type recoverJobsResponse struct {
	Recovered int `json:"recovered"`
}

type retryResponse struct {
	Execution wfstore.Execution     `json:"execution"`
	Step      wfstore.ExecutionStep `json:"step"`
	Job       wfstore.ExecutionJob  `json:"job"`
}

func (s *Server) claimJob(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req claimJobRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	result, err := s.workflows.ClaimJob(r.Context(), scope, s.now(), wfstore.ClaimInput{
		WorkerID: strings.TrimSpace(req.WorkerID),
		Lease:    secondsDuration(req.LeaseSeconds),
	})
	if errors.Is(err, wfstore.ErrEmptyClaim) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	if err := wfstore.AuthorizeJobBinding(result.Binding, scope.WorkspaceID(), result.Execution.WorkflowVersionID, result.Execution.WorkflowDigest, s.now()); err != nil {
		s.emitSecurityError(r, scope, err)
		writeWorkflowStoreError(w, r, err)
		return
	}
	token, err := wfstore.SignJobTicket(s.jobKey, result.Binding)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, claimJobResponse{
		Claimed:   true,
		JobToken:  token,
		Binding:   result.Binding,
		Job:       result.Job,
		Step:      result.Step,
		Execution: result.Execution,
		Recovered: result.Recovered,
	})
}

func (s *Server) recoverJobs(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	n, err := s.workflows.RecoverExpiredLeases(r.Context(), scope, s.now())
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, recoverJobsResponse{Recovered: n})
}

func (s *Server) heartbeatJob(w http.ResponseWriter, r *http.Request) {
	s.workerJobAction(w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		return s.workflows.HeartbeatJob(r.Context(), scope, s.now(), in)
	})
}

func (s *Server) releaseJob(w http.ResponseWriter, r *http.Request) {
	s.workerJobAction(w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		return s.workflows.ReleaseJob(r.Context(), scope, s.now(), in)
	})
}

func (s *Server) completeJob(w http.ResponseWriter, r *http.Request) {
	s.workerJobAction(w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		return s.workflows.CompleteJob(r.Context(), scope, s.now(), in)
	})
}

func (s *Server) failJob(w http.ResponseWriter, r *http.Request) {
	s.workerJobAction(w, r, func(scope isolation.Scope, in wfstore.JobActionInput) (wfstore.DispatchResult, error) {
		return s.workflows.FailJob(r.Context(), scope, s.now(), in)
	})
}

func (s *Server) workerJobAction(w http.ResponseWriter, r *http.Request, fn func(isolation.Scope, wfstore.JobActionInput) (wfstore.DispatchResult, error)) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req jobActionRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	binding, err := wfstore.ParseJobTicket(s.jobKey, req.JobToken)
	if err != nil {
		s.emitSecurityError(r, scope, err)
		writeWorkflowStoreError(w, r, err)
		return
	}
	if binding.JobID != jobID || binding.WorkspaceID != scope.WorkspaceID() {
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	if err := wfstore.AuthorizeJobBinding(binding, scope.WorkspaceID(), "", "", s.now()); err != nil {
		s.emitSecurityError(r, scope, err)
		writeWorkflowStoreError(w, r, err)
		return
	}
	if req.FencingToken != 0 && req.FencingToken != binding.FencingToken {
		writeWorkflowStoreError(w, r, wfstore.ErrFenceConflict)
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
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, dispatchJobResponse{Job: result.Job, Step: result.Step, Execution: result.Execution})
}

func (s *Server) cancelExecution(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionCancel)
	if !ok {
		return
	}
	if r.ContentLength > 0 {
		var req retryStepRequest
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	exec, err := s.workflows.CancelExecution(r.Context(), scope, s.now(), strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	s.writeExecutionDetail(w, r, scope, exec, http.StatusOK)
}

func (s *Server) retryExecution(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req retryStepRequest
	if r.ContentLength > 0 {
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	stepID := strings.TrimSpace(firstNonEmpty(r.PathValue("stepId"), req.StepID))
	if stepID == "" {
		steps, err := s.workflows.ListSteps(r.Context(), scope, executionID)
		if err != nil {
			writeWorkflowStoreError(w, r, err)
			return
		}
		for i := len(steps) - 1; i >= 0; i-- {
			if steps[i].Status == wfstore.ExecutionFailed || steps[i].Status == wfstore.ExecutionCanceled {
				stepID = steps[i].ID
				break
			}
		}
		if stepID == "" {
			writeWorkflowStoreError(w, r, wfstore.ErrRetryNotAllowed)
			return
		}
	}
	hint := s.retryHint(r.Context(), scope, executionID, stepID)
	result, err := s.workflows.RetryStep(r.Context(), scope, s.now(), executionID, stepID, hint)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, retryResponse{Execution: result.Execution, Step: result.Step, Job: result.Job})
}

func (s *Server) retryHint(ctx context.Context, scope isolation.Scope, executionID, stepID string) map[string]any {
	if hint := s.sshRetryHint(ctx, scope, executionID, stepID); hint != nil {
		return hint
	}
	return s.scriptRetryHint(ctx, scope, executionID, stepID)
}

func (s *Server) scriptRetryHint(ctx context.Context, scope isolation.Scope, executionID, stepID string) map[string]any {
	if s.workflows == nil {
		return nil
	}
	step, err := s.workflows.GetStep(ctx, scope, executionID, stepID)
	if err != nil || !scripts.IsScriptNode(step.NodeType) {
		return nil
	}
	exec, err := s.workflows.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		return nil
	}
	ver, err := s.workflows.GetVersion(ctx, scope, exec.WorkflowID, exec.WorkflowVersionID)
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

func (s *Server) sshRetryHint(ctx context.Context, scope isolation.Scope, executionID, stepID string) map[string]any {
	if s.ops == nil || s.workflows == nil {
		return nil
	}
	step, err := s.workflows.GetStep(ctx, scope, executionID, stepID)
	if err != nil || step.NodeType != ssheng.NodeSSHRun {
		return nil
	}
	exec, err := s.workflows.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		return nil
	}
	ver, err := s.workflows.GetVersion(ctx, scope, exec.WorkflowID, exec.WorkflowVersionID)
	if err != nil {
		return nil
	}
	pins, err := s.ops.ListPins(ctx, scope, opsconfig.OwnerExecution, executionID)
	if err != nil || len(pins) == 0 {
		pins, err = s.ops.ListPins(ctx, scope, opsconfig.OwnerWorkflowVersion, exec.WorkflowVersionID)
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

func (s *Server) now() time.Time {
	if s.clock != nil {
		return s.clock().UTC()
	}
	return time.Now().UTC()
}

func secondsDuration(n int) time.Duration {
	if n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Second
}
