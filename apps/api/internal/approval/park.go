package approval

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/jackc/pgx/v5"
)

// ExpirePendingGate closes a still-pending approval because its gate is no
// longer waiting. No decider is recorded. The event is secret-free.
func ExpirePendingGate(ctx context.Context, tx pgx.Tx, executionID, nodeID string, now time.Time) error {
	return mapDBErr(parkedapproval.Expire(ctx, tx, executionID, nodeID, now))
}

// GateStillWaiting reports whether the latest flow.approval step for nodeID
// is still waiting, and whether such a step exists. The caller holds the
// execution row lock.
func GateStillWaiting(ctx context.Context, tx pgx.Tx, executionID, nodeID string) (found, waiting bool, err error) {
	found, waiting, err = parkedapproval.GateWaiting(ctx, tx, executionID, nodeID)
	if err != nil {
		return false, false, mapDBErr(err)
	}
	return found, waiting, nil
}
