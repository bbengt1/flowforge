package approval

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5"
)

// ErrorWorkflowGate is the #649 S3 pre-start check for an engine-started
// error-workflow run: the same policy evaluation schedule and webhook
// starts run before StartExecution. It fails closed. A deny, any pre-run
// approval requirement (an error run has nobody to approve it), or an
// evaluation error skips the run with a reason. With a transaction
// (Postgres), pins are read in it; otherwise ops is used (Memory).
func ErrorWorkflowGate(ops PinSource, now func() time.Time) wfstore.ErrorWorkflowGate {
	if now == nil {
		now = time.Now
	}
	return func(ctx context.Context, tx pgx.Tx, scope isolation.Scope, ver wfstore.Version) string {
		src := ops
		if tx != nil {
			src = opsconfig.TxPins{Tx: tx}
		}
		pins, err := ResolvePins(ctx, scope, src, ver.DefinitionYAML)
		if err != nil {
			return wfstore.ErrorSkipPolicyUnavailable
		}
		res, err := policy.Evaluate(policy.Input{
			YAML:              ver.DefinitionYAML,
			WorkflowVersionID: ver.ID,
			WorkflowDigest:    ver.Digest,
			Pins:              pins,
			Now:               now().UTC(),
		})
		if err != nil {
			return wfstore.ErrorSkipPolicyUnavailable
		}
		switch res.Decision {
		case policy.DecisionAllow:
		case policy.DecisionDeny:
			return wfstore.ErrorSkipPolicyDenied
		default:
			return wfstore.ErrorSkipApprovalRequired
		}
		for _, req := range res.Requirements {
			if !req.Wait {
				return wfstore.ErrorSkipApprovalRequired
			}
		}
		return ""
	}
}
