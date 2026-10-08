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

// ErrNoEligibleDecider means a targeted gate has nobody but the requester
// who could ever decide it: no named user or live group member who is
// active, bound, holds approval.decide, meets the role, and is not the
// requester, and no active admin other than the requester. The caller
// fails the gate with requirement_unresolvable and cause
// no_eligible_decider. Nothing is written.
var ErrNoEligibleDecider = errors.New("approval gate has no eligible decider")

// ErrNotReadCommitted means a park ran in a transaction that is not READ
// COMMITTED, so its approver read could be stale (see
// LockWorkspaceForPark). The park fails closed.
var ErrNotReadCommitted = errors.New("approval park needs a read committed transaction")

// CauseNoEligibleDecider is the details.cause for ErrNoEligibleDecider.
const CauseNoEligibleDecider = "no_eligible_decider"

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
	// ApproversDigest is '' for an untargeted gate. When set, the named
	// users and groups are resolved in this transaction.
	ApproversDigest string
	ApproverUsers   []string
	ApproverGroups  []string
}

// Fingerprint matches approval.BindingFingerprint. The approver role and
// the target and policy version ids are part of the bind, so a row minted
// for a different role cannot be reused.
//
// approversDigest is appended only when non-empty, so an untargeted gate
// keeps the fingerprint it had before approver targeting existed.
func Fingerprint(workspaceID, workflowVersionID, workflowDigest, targetVersionID, policyVersionID, policyDigest, operation, nodeID, approverRole, executionID, approversDigest string) string {
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
	if d := strings.TrimSpace(approversDigest); d != "" {
		parts = append(parts, "approvers="+d)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// LockWorkspaceForPark takes the workspace row FOR SHARE in tx. Every
// pending targeted approval is written by Insert, which takes this lock
// before it resolves the approver snapshot. A caller that locks an
// execution first (WaitJob) must call it before that execution lock, so
// the order is the same as a membership change: workspace row, then
// executions, then approvals.
//
// Every change that can shrink a gate's decider set (removal, demotion,
// group delete or member removal, SCIM) holds the same row FOR NO KEY
// UPDATE, which conflicts with FOR SHARE. A park that starts while such
// a change is in flight waits for it to commit and then reads the new
// membership, so it can never snapshot a decider the change is about to
// remove; the change in turn re-checks only the gates that already
// exist. FOR SHARE does not conflict with itself or with the FOR KEY
// SHARE that foreign-key checks take, so parks never wait on each other
// or on run inserts. FOR KEY SHARE would not conflict with FOR NO KEY
// UPDATE and so would not serialize anything.
//
// A transaction that holds this share lock must never go on to take
// identity.LockWorkspaceMembership (FOR NO KEY UPDATE), directly or
// through GuardLastAdmin: two parks that each hold the share lock and
// both try to upgrade wait on each other and deadlock. Membership
// changes take the stronger lock first and never this one.
// TestParkLockHoldersNeverTakeMembershipLock enforces this.
//
// Isolation: the transaction must be READ COMMITTED (the server default;
// postgres.BeginScoped does not change it). Every statement after this
// lock then takes a fresh snapshot, so the approver read that follows
// (ResolveSnapshot: group rows, role bindings and users.status) sees any
// membership change or instance-wide disable that committed before the
// lock was granted. Under REPEATABLE READ or SERIALIZABLE the snapshot
// is fixed at the transaction's first statement, before this lock, and
// the park could keep a decider who was just removed or disabled. The
// lock reads the transaction's level in the same statement and fails
// closed (ErrNotReadCommitted) on anything else.
//
// An instance-wide disable (identity SetUserStatus) commits users.status
// first and then re-checks each workspace under the FOR NO KEY UPDATE
// lock. A park that read the user as active before that commit holds
// this share lock until it commits, so the re-check waits for it and
// then sees its gate; a park that starts after the commit reads the
// user as disabled.
//
// ErrInvalid: the workspace id is malformed or the row does not exist.
func LockWorkspaceForPark(ctx context.Context, tx pgx.Tx, workspaceID string) error {
	if !authz.ValidUUID(workspaceID) {
		return ErrInvalid
	}
	var level string
	err := tx.QueryRow(ctx, `
		SELECT current_setting('transaction_isolation') FROM workspaces WHERE id = $1::uuid FOR SHARE
	`, workspaceID).Scan(&level)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvalid
	}
	if err != nil {
		return err
	}
	if level != "read committed" {
		return ErrNotReadCommitted
	}
	return nil
}

// Insert writes a pending approval in the caller's transaction. It is
// the only writer of pending targeted approvals (a convention test
// enforces this). A targeted gate takes LockWorkspaceForPark before its
// snapshot is resolved; it is a no-op when the caller already holds it.
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
	digest := strings.TrimSpace(in.ApproversDigest)
	var snap Snapshot
	if digest != "" {
		if err := LockWorkspaceForPark(ctx, tx, in.WorkspaceID); err != nil {
			return err
		}
		var err error
		snap, err = ResolveSnapshot(ctx, tx, in.WorkspaceID, in.RequestedBy, role, in.ApproverUsers, in.ApproverGroups)
		if err != nil {
			return err
		}
		if !snap.HasDecider {
			return ErrNoEligibleDecider
		}
	}
	fp := Fingerprint(in.WorkspaceID, in.WorkflowVersionID, in.WorkflowDigest, in.TargetVersionID, in.PolicyVersionID, in.PolicyDigest, operation, nodeID, role, in.ExecutionID, digest)
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
			binding_fingerprint, approver_role, status, expires_at, requested_by, approvers_digest
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
			$6, $7, $8, $9, $10::uuid, $11::uuid, $12,
			$13::uuid, $14::uuid, $15, $16,
			$17, $18, 'pending', $19, $20::uuid, $21
		)
		RETURNING id::text
	`, in.WorkspaceID, in.WorkflowID, in.WorkflowVersionID, strings.TrimSpace(in.WorkflowDigest), nullUUID(in.ExecutionID),
		nodeID, in.NodeName, operation, in.TargetKind, nullUUID(in.TargetID), nullUUID(in.TargetVersionID), in.TargetDigest,
		nullUUID(in.PolicyResourceID), nullUUID(in.PolicyVersionID), in.PolicyDigest, in.PolicyRevision,
		fp, role, expires, requestedBy(in), digest,
	).Scan(&id)
	if err != nil {
		return err
	}
	if digest != "" {
		if err := WriteSnapshot(ctx, tx, in.WorkspaceID, id, snap); err != nil {
			return err
		}
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

// CancelUnresolvable closes a still-pending approval for this execution and
// node because the gate's retry deadline passed. close_reason is
// requirement_unresolvable and no decider is recorded. No matching row is
// a no-op. The event is secret-free.
func CancelUnresolvable(ctx context.Context, tx pgx.Tx, executionID, nodeID string, now time.Time) error {
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
			   SET status = 'canceled',
			       close_reason = 'requirement_unresolvable',
			       decided_by = NULL,
			       decided_at = NULL,
			       updated_at = $3
			 WHERE execution_id = $1::uuid
			   AND node_id = $2
			   AND status = 'pending'
			   AND workspace_id = app.current_workspace_id()
			RETURNING workspace_id, id
		)
		INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details, occurred_at)
		SELECT workspace_id, id, 'canceled', NULL, '{"reason":"requirement_unresolvable"}'::jsonb, $3
		  FROM closed
	`, executionID, nodeID, now)
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
