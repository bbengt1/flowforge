package runner

import (
	"context"
	"errors"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
)

// approvalBindingError is a fail-closed lookup or evaluation failure.
// The claim loop fails the job and does not park the gate.
type approvalBindingError struct {
	cause error
}

func (e approvalBindingError) Error() string {
	if e.cause == nil {
		return "approval binding unresolved"
	}
	return e.cause.Error()
}

func (e approvalBindingError) Unwrap() error { return e.cause }

func bindingUnresolved(err error) error {
	if err == nil {
		err = errors.New("approval binding unresolved")
	}
	return approvalBindingError{cause: err}
}

// parkApproval creates the approval row in the same transaction that parks
// the gate. expires_at is the wait deadline, not a later recomputation.
// A missing version, a failed evaluation, or a missing wait requirement
// returns approvalBindingError and does not park.
func (r *Runner) parkApproval(ctx context.Context, ws Workspace, job Job, until time.Time) error {
	seed, err := r.approvalSeed(ctx, ws, job, until)
	if err != nil {
		return err
	}
	if q, ok := r.queue.(*StoreQueue); ok {
		return q.ParkApproval(ctx, ws, job, until, seed)
	}
	return bindingUnresolved(errors.New("approval binding unresolved"))
}

func (r *Runner) approvalSeed(ctx context.Context, ws Workspace, job Job, until time.Time) (approval.CreateInput, error) {
	q, ok := r.queue.(*StoreQueue)
	if !ok || q.Workflows == nil {
		return approval.CreateInput{}, bindingUnresolved(errors.New("workflow version is not available"))
	}
	scope, err := scopeFor(ws)
	if err != nil {
		return approval.CreateInput{}, bindingUnresolved(err)
	}
	ver, err := q.Workflows.GetVersion(ctx, scope, job.Execution.WorkflowID, job.Execution.WorkflowVersionID)
	if err != nil {
		return approval.CreateInput{}, bindingUnresolved(err)
	}
	var pins []opsconfig.Pin
	if r.disp != nil && r.disp.Ops != nil {
		refs := opsconfig.ExtractRefs(ver.DefinitionYAML)
		if len(refs) > 0 {
			pins, err = r.disp.Ops.Resolve(ctx, scope, refs)
			if err != nil {
				return approval.CreateInput{}, bindingUnresolved(err)
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
		return approval.CreateInput{}, bindingUnresolved(err)
	}
	for _, item := range eval.Requirements {
		if item.NodeID != job.Step.NodeID || !item.Wait {
			continue
		}
		item.ExpiresAt = until
		return approval.CreateInput{
			WorkflowID:        job.Execution.WorkflowID,
			WorkflowVersionID: job.Execution.WorkflowVersionID,
			WorkflowDigest:    job.Execution.WorkflowDigest,
			ExecutionID:       job.Execution.ID,
			RequestedBy:       job.Execution.RequestedBy,
			Requirement:       item,
		}, nil
	}
	return approval.CreateInput{}, bindingUnresolved(errors.New("approval requirement is missing"))
}
