package approval

import (
	"context"
	"errors"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/jackc/pgx/v5"
)

// InsertParked writes a pending approval in the caller's transaction.
// expiresAt is the gate's wait deadline. The requirement's own ExpiresAt
// is not used, so a later evaluation cannot move the deadline.
// An existing pending row for the same fingerprint keeps its binding and
// takes this deadline. An already-approved row is left alone.
func InsertParked(ctx context.Context, tx pgx.Tx, scope isolation.Scope, in CreateInput, expiresAt time.Time) error {
	if scope.Zero() {
		return ErrNoScope
	}
	req := in.Requirement
	err := parkedapproval.Insert(ctx, tx, parkedapproval.Pending{
		WorkspaceID:       scope.WorkspaceID(),
		ActorID:           scope.ActorID(),
		WorkflowID:        in.WorkflowID,
		WorkflowVersionID: in.WorkflowVersionID,
		WorkflowDigest:    in.WorkflowDigest,
		ExecutionID:       in.ExecutionID,
		RequestedBy:       in.RequestedBy,
		NodeID:            req.NodeID,
		NodeName:          req.NodeName,
		Operation:         req.Operation,
		TargetKind:        req.TargetKind,
		TargetID:          req.TargetID,
		TargetVersionID:   req.TargetVersionID,
		TargetDigest:      req.TargetDigest,
		PolicyResourceID:  req.PolicyResourceID,
		PolicyVersionID:   req.PolicyVersionID,
		PolicyDigest:      req.PolicyDigest,
		PolicyRevision:    req.PolicyRevision,
		ApproverRole:      req.ApproverRole,
		ExpiresAt:         expiresAt,
	})
	if errors.Is(err, parkedapproval.ErrInvalid) {
		return ErrInvalid
	}
	return mapDBErr(err)
}

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
