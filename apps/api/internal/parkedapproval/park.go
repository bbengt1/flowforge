// Package parkedapproval writes the approval row that shares a transaction
// with a parked gate. It does not import the approval or workflow stores,
// so either of those packages can call it.
package parkedapproval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/jackc/pgx/v5"
)

// ErrInvalid means the parked approval is missing a required field.
var ErrInvalid = errors.New("invalid parked approval")

// Pending is the row inserted when a gate starts waiting.
// ExpiresAt is the wait deadline. It is not recomputed here.
type Pending struct {
	WorkspaceID       string
	ActorID           string
	WorkflowID        string
	WorkflowVersionID string
	WorkflowDigest    string
	ExecutionID       string
	RequestedBy       string
	NodeID            string
	NodeName          string
	Operation         string
	TargetKind        string
	TargetID          string
	TargetVersionID   string
	TargetDigest      string
	PolicyResourceID  string
	PolicyVersionID   string
	PolicyDigest      string
	PolicyRevision    int
	ApproverRole      string
	ExpiresAt         time.Time
}

// Fingerprint matches approval.BindingFingerprint. The approver role and
// the target and policy version ids are part of the bind, so a row minted
// for a different role cannot be reused.
func Fingerprint(workspaceID, workflowVersionID, workflowDigest, targetVersionID, policyVersionID, policyDigest, operation, nodeID, approverRole, executionID string) string {
	role := strings.TrimSpace(approverRole)
	if role == "" {
		role = "approver"
	}
	parts := []string{
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(workflowVersionID),
		strings.TrimSpace(workflowDigest),
		strings.TrimSpace(targetVersionID),
		strings.TrimSpace(policyVersionID),
		strings.TrimSpace(policyDigest),
		strings.TrimSpace(operation),
		strings.TrimSpace(nodeID),
		role,
	}
	if exec := strings.TrimSpace(executionID); exec != "" {
		parts = append(parts, exec)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Insert writes a pending approval in the caller's transaction.
// An existing pending row for the same fingerprint keeps its binding and
// takes this deadline. An already-approved row is left alone.
func Insert(ctx context.Context, tx pgx.Tx, in Pending) error {
	if strings.TrimSpace(in.WorkspaceID) == "" || in.ExpiresAt.IsZero() {
		return ErrInvalid
	}
	if !authz.ValidUUID(in.WorkflowID) || !authz.ValidUUID(in.WorkflowVersionID) {
		return ErrInvalid
	}
	nodeID := strings.TrimSpace(in.NodeID)
	operation := strings.TrimSpace(in.Operation)
	if nodeID == "" || operation == "" {
		return ErrInvalid
	}
	role := strings.TrimSpace(in.ApproverRole)
	if role == "" {
		role = "approver"
	}
	expires := in.ExpiresAt.UTC()
	now := time.Now().UTC()
	fp := Fingerprint(in.WorkspaceID, in.WorkflowVersionID, in.WorkflowDigest, in.TargetVersionID, in.PolicyVersionID, in.PolicyDigest, operation, nodeID, role, in.ExecutionID)
	if err := SupersedeOtherPending(ctx, tx, in.WorkspaceID, in.ExecutionID, nodeID, fp, now); err != nil {
		return err
	}
	var existingID, existingStatus string
	var existingExpires time.Time
	err := tx.QueryRow(ctx, `
		SELECT id::text, status, expires_at
		  FROM approvals
		 WHERE binding_fingerprint = $1 AND status IN ('pending', 'approved')
		 LIMIT 1
	`, fp).Scan(&existingID, &existingStatus, &existingExpires)
	if err == nil {
		if existingStatus != "pending" || existingExpires.UTC().Equal(expires) {
			return nil
		}
		_, err = tx.Exec(ctx, `
			UPDATE approvals SET expires_at = $2, updated_at = $3 WHERE id = $1::uuid AND status = 'pending'
		`, existingID, expires, now)
		return err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO approvals (
			workspace_id, workflow_id, workflow_version_id, workflow_digest, execution_id,
			node_id, node_name, operation, target_kind, target_id, target_version_id, target_digest,
			policy_resource_id, policy_version_id, policy_digest, policy_revision,
			binding_fingerprint, approver_role, status, expires_at, requested_by
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
			$6, $7, $8, $9, $10::uuid, $11::uuid, $12,
			$13::uuid, $14::uuid, $15, $16,
			$17, $18, 'pending', $19, $20::uuid
		)
		RETURNING id::text
	`, in.WorkspaceID, in.WorkflowID, in.WorkflowVersionID, strings.TrimSpace(in.WorkflowDigest), nullUUID(in.ExecutionID),
		nodeID, in.NodeName, operation, in.TargetKind, nullUUID(in.TargetID), nullUUID(in.TargetVersionID), in.TargetDigest,
		nullUUID(in.PolicyResourceID), nullUUID(in.PolicyVersionID), in.PolicyDigest, in.PolicyRevision,
		fp, role, expires, requestedBy(in),
	).Scan(&id)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(map[string]any{"operation": operation, "nodeId": nodeID})
	if err != nil {
		return ErrInvalid
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details)
		VALUES ($1::uuid, $2::uuid, 'created', $3::uuid, $4::jsonb)
	`, in.WorkspaceID, id, nullUUID(in.ActorID), raw)
	return err
}

// SupersedeOtherPending invalidates other pending rows for the same
// execution and node whose fingerprint does not match. A row bound to the
// wrong approver role, target, or policy cannot stay decidable.
func SupersedeOtherPending(ctx context.Context, tx pgx.Tx, workspaceID, executionID, nodeID, fingerprint string, now time.Time) error {
	executionID = strings.TrimSpace(executionID)
	nodeID = strings.TrimSpace(nodeID)
	if !authz.ValidUUID(workspaceID) || !authz.ValidUUID(executionID) || nodeID == "" || fingerprint == "" {
		return nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	_, err := tx.Exec(ctx, `
		WITH closed AS (
			UPDATE approvals
			   SET status = 'invalidated',
			       updated_at = $5
			 WHERE workspace_id = $1::uuid
			   AND execution_id = $2::uuid
			   AND node_id = $3
			   AND status = 'pending'
			   AND binding_fingerprint <> $4
			RETURNING workspace_id, id
		)
		INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details, occurred_at)
		SELECT workspace_id, id, 'invalidated', NULL, '{"reason":"approver_binding_replaced"}'::jsonb, $5
		  FROM closed
	`, workspaceID, executionID, nodeID, fingerprint, now)
	return err
}

// Expire closes a still-pending approval because its gate is no longer waiting.
// No decider is recorded. The event is secret-free.
func Expire(ctx context.Context, tx pgx.Tx, executionID, nodeID string, now time.Time) error {
	if executionID == "" || nodeID == "" {
		return nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	_, err := tx.Exec(ctx, `
		WITH closed AS (
			UPDATE approvals
			   SET status = 'expired',
			       close_reason = NULL,
			       decided_by = NULL,
			       decided_at = NULL,
			       updated_at = $3
			 WHERE execution_id = $1::uuid
			   AND node_id = $2
			   AND status = 'pending'
			RETURNING workspace_id, id
		)
		INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details, occurred_at)
		SELECT workspace_id, id, 'expired', NULL, '{"reason":"gate_expired"}'::jsonb, $3
		  FROM closed
	`, executionID, nodeID, now)
	return err
}

// GateWaiting reports whether the latest flow.approval step for nodeID is
// still waiting, and whether such a step exists.
func GateWaiting(ctx context.Context, tx pgx.Tx, executionID, nodeID string) (found, waiting bool, err error) {
	var stepStatus, jobStatus string
	err = tx.QueryRow(ctx, `
		SELECT s.status, COALESCE((
			SELECT j.status FROM execution_jobs j
			 WHERE j.workspace_id = s.workspace_id AND j.execution_step_id = s.id
			 ORDER BY j.created_at DESC
			 LIMIT 1
		), '')
		  FROM execution_steps s
		 WHERE s.execution_id = $1::uuid
		   AND s.node_id = $2
		   AND s.node_type = 'flow.approval'
		 ORDER BY s.attempt DESC
		 LIMIT 1
	`, executionID, nodeID).Scan(&stepStatus, &jobStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, false, nil
		}
		return false, false, err
	}
	return true, stepStatus == "waiting" && jobStatus == "waiting", nil
}

func requestedBy(in Pending) any {
	if id := strings.TrimSpace(in.RequestedBy); authz.ValidUUID(id) {
		return id
	}
	return nullUUID(in.ActorID)
}

func nullUUID(id string) any {
	if authz.ValidUUID(id) {
		return id
	}
	return nil
}
