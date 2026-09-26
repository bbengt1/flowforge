package runner

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
)

// parkApproval creates the approval row in the same transaction that parks
// the gate. expires_at is the wait deadline, not a later recomputation.
func (r *Runner) parkApproval(ctx context.Context, ws Workspace, job Job, until time.Time) error {
	seed, err := r.approvalSeed(ctx, ws, job, until)
	if err != nil {
		return err
	}
	if q, ok := r.queue.(*StoreQueue); ok {
		return q.ParkApproval(ctx, ws, job, until, seed)
	}
	return r.queue.Park(ctx, ws, job, until)
}

func (r *Runner) approvalSeed(ctx context.Context, ws Workspace, job Job, until time.Time) (approval.CreateInput, error) {
	fallback := approval.CreateInput{
		WorkflowID:        job.Execution.WorkflowID,
		WorkflowVersionID: job.Execution.WorkflowVersionID,
		WorkflowDigest:    job.Execution.WorkflowDigest,
		ExecutionID:       job.Execution.ID,
		RequestedBy:       job.Execution.RequestedBy,
		Requirement: policy.Requirement{
			NodeID:       job.Step.NodeID,
			NodeName:     job.Step.NodeID,
			Operation:    "flow.approval",
			ApproverRole: "approver",
			ExpiresAt:    until,
			Wait:         true,
		},
	}
	q, ok := r.queue.(*StoreQueue)
	if !ok || q.Workflows == nil {
		return fallback, nil
	}
	scope, err := scopeFor(ws)
	if err != nil {
		return approval.CreateInput{}, err
	}
	ver, err := q.Workflows.GetVersion(ctx, scope, job.Execution.WorkflowID, job.Execution.WorkflowVersionID)
	if err != nil {
		return fallback, nil
	}
	var pins []opsconfig.Pin
	if r.disp != nil && r.disp.Ops != nil {
		refs := opsconfig.ExtractRefs(ver.DefinitionYAML)
		if len(refs) > 0 {
			pins, err = r.disp.Ops.Resolve(ctx, scope, refs)
			if err != nil {
				return approval.CreateInput{}, err
			}
		}
	}
	eval, err := policy.Evaluate(policy.Input{
		YAML:              ver.DefinitionYAML,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Pins:              pins,
		Now:               r.now(),
	})
	if err != nil {
		return fallback, nil
	}
	for _, item := range eval.Requirements {
		if item.NodeID != job.Step.NodeID || !item.Wait {
			continue
		}
		return approval.CreateInput{
			WorkflowID:        job.Execution.WorkflowID,
			WorkflowVersionID: job.Execution.WorkflowVersionID,
			WorkflowDigest:    job.Execution.WorkflowDigest,
			ExecutionID:       job.Execution.ID,
			RequestedBy:       job.Execution.RequestedBy,
			Requirement:       item,
		}, nil
	}
	return fallback, nil
}
