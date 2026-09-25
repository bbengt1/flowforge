package approval

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const recordColumns = `
	id::text, workflow_id::text, workflow_version_id::text, workflow_digest,
	COALESCE(execution_id::text, ''), node_id, node_name, operation,
	target_kind, COALESCE(target_id::text, ''), COALESCE(target_version_id::text, ''), target_digest,
	COALESCE(policy_resource_id::text, ''), COALESCE(policy_version_id::text, ''), policy_digest, policy_revision,
	binding_fingerprint, approver_role, status, expires_at,
	COALESCE(requested_by::text, ''), COALESCE(decided_by::text, ''), decided_at, decision_note,
	COALESCE(close_reason, ''),
	created_at, updated_at
`

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Postgres persists approvals under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed approval store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	rec, err := recordFromCreate(scope, in, time.Now().UTC())
	if err != nil {
		return Record{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var existing Record
	err = scanRecord(tx.QueryRow(ctx, `SELECT `+recordColumns+`
		FROM approvals
		WHERE binding_fingerprint = $1 AND status IN ('pending', 'approved')
		LIMIT 1`, rec.BindingFingerprint), &existing)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return Record{}, mapDBErr(err)
		}
		return existing, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Record{}, err
	}

	out, err := insertRecord(ctx, tx, scope, rec)
	if err != nil {
		return Record{}, err
	}
	if err := insertEvent(ctx, tx, scope, out.ID, EventCreated, scope.ActorID(), map[string]any{
		"operation": out.Operation, "nodeId": out.NodeID,
	}); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) List(ctx context.Context, scope isolation.Scope, filter Filter) ([]Record, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	if filter.Page.Bound && (filter.Page.Limit < 1 || filter.Page.Limit > page.MaxLimit) {
		return nil, page.ErrInvalid
	}
	args := []any{}
	var parts []string
	if filter.Status != "" {
		parts = append(parts, "status = $"+page.Place(&args, filter.Status))
	}
	if filter.WorkflowID != "" {
		parts = append(parts, "workflow_id = $"+page.Place(&args, filter.WorkflowID)+"::uuid")
	}
	if filter.WorkflowVersionID != "" {
		parts = append(parts, "workflow_version_id = $"+page.Place(&args, filter.WorkflowVersionID)+"::uuid")
	}
	if filter.ExecutionID != "" {
		parts = append(parts, "execution_id = $"+page.Place(&args, filter.ExecutionID)+"::uuid")
	}
	order := ` ORDER BY created_at DESC`
	if filter.Page.Bound {
		if pred := page.SearchPredicate(&args, filter.Page.Q, "node_id", "node_name", "operation", "status"); pred != "" {
			parts = append(parts, pred)
		}
		keyset, err := page.DescTimePredicate(&args, page.ColApproval, "created_at", "id", filter.Page.Cursor)
		if err != nil {
			return nil, err
		}
		if keyset != "" {
			parts = append(parts, keyset)
		}
		order = ` ORDER BY created_at DESC, id DESC` + page.LimitSQL(&args, filter.Page)
	}
	q := `SELECT ` + recordColumns + ` FROM approvals`
	if len(parts) > 0 {
		q += " WHERE " + page.And(parts...)
	}
	rows, err := tx.Query(ctx, q+order, args...)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var rec Record
		if err := scanRecord(rows, &rec); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if filter.Page.Bound {
		paged, next, err := page.Trim(page.ColApproval, filter.Page, out, func(rec Record) page.Key {
			return page.Key{K: page.TimeKey(rec.CreatedAt), ID: rec.ID}
		})
		if err != nil {
			return nil, err
		}
		page.Remember(filter.Page, next)
		out = paged
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, id string) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Record{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var rec Record
	if err := scanRecord(tx.QueryRow(ctx, `SELECT `+recordColumns+` FROM approvals WHERE id = $1::uuid`, id), &rec); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) Decide(ctx context.Context, scope isolation.Scope, id string, in DecideInput) (Record, error) {
	decision, err := NormalizeDecision(in.Decision)
	if err != nil {
		return Record{}, err
	}
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	note := strings.TrimSpace(in.Note)
	if len(note) > 2000 {
		return Record{}, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var rec Record
	if err := scanRecord(tx.QueryRow(ctx, `SELECT `+recordColumns+` FROM approvals WHERE id = $1::uuid`, id), &rec); err != nil {
		return Record{}, err
	}
	if rec.Status == StatusCanceled {
		return Record{}, ErrClosed
	}
	if rec.ExecutionID != "" {
		closed, err := refuseClosedRunTx(ctx, tx, rec.ExecutionID, now)
		if err != nil {
			return Record{}, err
		}
		if closed {
			if err := tx.Commit(ctx); err != nil {
				return Record{}, mapDBErr(err)
			}
			return Record{}, ErrClosed
		}
	}
	if err := scanRecord(tx.QueryRow(ctx, `SELECT `+recordColumns+` FROM approvals WHERE id = $1::uuid FOR UPDATE`, id), &rec); err != nil {
		return Record{}, err
	}
	if rec.Status == StatusCanceled {
		return Record{}, ErrClosed
	}
	if scope.ActorID() != "" && rec.RequestedBy != "" && scope.ActorID() == rec.RequestedBy {
		return Record{}, ErrSelfApproval
	}
	status, reason := Freshness(rec, in.Heads, now)
	if status != rec.Status && (status == StatusExpired || status == StatusInvalidated) {
		rec, err = updateStatus(ctx, tx, scope, rec, status, reason, now)
		if err != nil {
			return Record{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Record{}, mapDBErr(err)
		}
		if status == StatusExpired {
			return rec, ErrExpired
		}
		return rec, ErrInvalidated
	}
	if rec.Status != StatusPending {
		return Record{}, ErrNotPending
	}
	if err := tx.QueryRow(ctx, `
		UPDATE approvals
		SET status = $2, decided_by = $3::uuid, decided_at = $4, decision_note = $5, updated_at = $4
		WHERE id = $1::uuid
		RETURNING `+recordColumns, id, decision, actorArg(scope), now, note).Scan(recordDest(&rec)...); err != nil {
		return Record{}, mapDBErr(err)
	}
	if err := insertEvent(ctx, tx, scope, rec.ID, decision, scope.ActorID(), map[string]any{"noteLength": len(note)}); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) ClosePendingForExecution(ctx context.Context, scope isolation.Scope, executionID, reason string, now time.Time) error {
	if scope.Zero() {
		return ErrNoScope
	}
	executionID = strings.TrimSpace(executionID)
	if !authz.ValidUUID(executionID) {
		return nil
	}
	if reason != ReasonRunCanceled && reason != ReasonWorkflowDeleted {
		return ErrInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := closePendingApprovalsTx(ctx, tx, executionID, reason, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return mapDBErr(err)
	}
	return nil
}

func (p *Postgres) Refresh(ctx context.Context, scope isolation.Scope, id string, heads CurrentHeads, now time.Time) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var rec Record
	if err := scanRecord(tx.QueryRow(ctx, `SELECT `+recordColumns+` FROM approvals WHERE id = $1::uuid`, id), &rec); err != nil {
		return Record{}, err
	}
	status, reason := Freshness(rec, heads, now)
	if status != rec.Status && (status == StatusExpired || status == StatusInvalidated) {
		rec, err = updateStatus(ctx, tx, scope, rec, status, reason, now)
		if err != nil {
			return Record{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) InvalidateMatching(ctx context.Context, scope isolation.Scope, in InvalidateInput) (int, error) {
	if scope.Zero() {
		return 0, ErrNoScope
	}
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	reason := strings.TrimSpace(in.Reason)
	if reason == "" {
		reason = "binding changed"
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return 0, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	q := `SELECT ` + recordColumns + ` FROM approvals WHERE status IN ('pending', 'approved')`
	args := []any{}
	n := 1
	if id := strings.TrimSpace(in.ResourceID); id != "" {
		q += ` AND (target_id = $` + itoa(n) + `::uuid OR policy_resource_id = $` + itoa(n) + `::uuid)`
		args = append(args, id)
	} else if id := strings.TrimSpace(in.TargetID); id != "" {
		q += ` AND target_id = $` + itoa(n) + `::uuid`
		args = append(args, id)
	} else if id := strings.TrimSpace(in.PolicyResourceID); id != "" {
		q += ` AND policy_resource_id = $` + itoa(n) + `::uuid`
		args = append(args, id)
	} else {
		if err := tx.Commit(ctx); err != nil {
			return 0, mapDBErr(err)
		}
		return 0, nil
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return 0, mapDBErr(err)
	}
	var recs []Record
	for rows.Next() {
		var rec Record
		if err := scanRecord(rows, &rec); err != nil {
			rows.Close()
			return 0, err
		}
		recs = append(recs, rec)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, mapDBErr(err)
	}
	for _, rec := range recs {
		if _, err := updateStatus(ctx, tx, scope, rec, StatusInvalidated, reason, now); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, mapDBErr(err)
	}
	return len(recs), nil
}

func (p *Postgres) Events(ctx context.Context, scope isolation.Scope, id string) ([]Event, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return nil, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var exists string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM approvals WHERE id = $1::uuid`, id).Scan(&exists); err != nil {
		return nil, mapDBErr(err)
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, approval_id::text, event_type, COALESCE(actor_id::text, ''), details, occurred_at
		FROM approval_events WHERE approval_id = $1::uuid ORDER BY occurred_at ASC
	`, id)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var ev Event
		var raw []byte
		if err := rows.Scan(&ev.ID, &ev.ApprovalID, &ev.EventType, &ev.ActorID, &raw, &ev.OccurredAt); err != nil {
			return nil, mapDBErr(err)
		}
		_ = json.Unmarshal(raw, &ev.Details)
		if ev.Details == nil {
			ev.Details = map[string]any{}
		}
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func insertRecord(ctx context.Context, tx pgx.Tx, scope isolation.Scope, rec Record) (Record, error) {
	var out Record
	err := scanRecord(tx.QueryRow(ctx, `
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
		RETURNING `+recordColumns,
		scope.WorkspaceID(), rec.WorkflowID, rec.WorkflowVersionID, rec.WorkflowDigest, nullUUID(rec.ExecutionID),
		rec.NodeID, rec.NodeName, rec.Operation, rec.TargetKind, nullUUID(rec.TargetID), nullUUID(rec.TargetVersionID), rec.TargetDigest,
		nullUUID(rec.PolicyResourceID), nullUUID(rec.PolicyVersionID), rec.PolicyDigest, rec.PolicyRevision,
		rec.BindingFingerprint, rec.ApproverRole, rec.ExpiresAt, requestedByArg(scope, rec.RequestedBy),
	), &out)
	return out, err
}

func requestedByArg(scope isolation.Scope, requestedBy string) any {
	requestedBy = strings.TrimSpace(requestedBy)
	if requestedBy != "" && authz.ValidUUID(requestedBy) {
		return requestedBy
	}
	return actorArg(scope)
}

func updateStatus(ctx context.Context, tx pgx.Tx, scope isolation.Scope, rec Record, status, reason string, now time.Time) (Record, error) {
	var out Record
	if err := scanRecord(tx.QueryRow(ctx, `
		UPDATE approvals SET status = $2, updated_at = $3 WHERE id = $1::uuid
		RETURNING `+recordColumns, rec.ID, status, now), &out); err != nil {
		return Record{}, err
	}
	if err := insertEvent(ctx, tx, scope, out.ID, status, scope.ActorID(), map[string]any{"reason": reason}); err != nil {
		return Record{}, err
	}
	return out, nil
}

func insertEvent(ctx context.Context, tx pgx.Tx, scope isolation.Scope, approvalID, eventType, actor string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return ErrInvalid
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb)
	`, scope.WorkspaceID(), approvalID, eventType, actorArg(scope), raw)
	return mapDBErr(err)
}

func scanRecord(row rowScanner, rec *Record) error {
	var decidedAt *time.Time
	err := row.Scan(
		&rec.ID, &rec.WorkflowID, &rec.WorkflowVersionID, &rec.WorkflowDigest,
		&rec.ExecutionID, &rec.NodeID, &rec.NodeName, &rec.Operation,
		&rec.TargetKind, &rec.TargetID, &rec.TargetVersionID, &rec.TargetDigest,
		&rec.PolicyResourceID, &rec.PolicyVersionID, &rec.PolicyDigest, &rec.PolicyRevision,
		&rec.BindingFingerprint, &rec.ApproverRole, &rec.Status, &rec.ExpiresAt,
		&rec.RequestedBy, &rec.DecidedBy, &decidedAt, &rec.DecisionNote, &rec.CloseReason,
		&rec.CreatedAt, &rec.UpdatedAt,
	)
	if err != nil {
		return mapDBErr(err)
	}
	rec.DecidedAt = decidedAt
	return nil
}

func recordDest(rec *Record) []any {
	return []any{
		&rec.ID, &rec.WorkflowID, &rec.WorkflowVersionID, &rec.WorkflowDigest,
		&rec.ExecutionID, &rec.NodeID, &rec.NodeName, &rec.Operation,
		&rec.TargetKind, &rec.TargetID, &rec.TargetVersionID, &rec.TargetDigest,
		&rec.PolicyResourceID, &rec.PolicyVersionID, &rec.PolicyDigest, &rec.PolicyRevision,
		&rec.BindingFingerprint, &rec.ApproverRole, &rec.Status, &rec.ExpiresAt,
		&rec.RequestedBy, &rec.DecidedBy, &rec.DecidedAt, &rec.DecisionNote, &rec.CloseReason,
		&rec.CreatedAt, &rec.UpdatedAt,
	}
}

// refuseClosedRunTx locks the execution, then closes a still-pending
// approval when the run was canceled or the workflow was deleted.
// A failed run that was not deleted is refused without a new close reason.
func refuseClosedRunTx(ctx context.Context, tx pgx.Tx, executionID string, now time.Time) (bool, error) {
	var status string
	var deleted, stopped bool
	err := tx.QueryRow(ctx, `
		SELECT e.status,
		       w.deleted_at IS NOT NULL,
		       EXISTS (
		           SELECT 1 FROM execution_steps s
		            WHERE s.workspace_id = e.workspace_id
		              AND s.execution_id = e.id
		              AND COALESCE(s.error_redacted->>'code', '') = 'workflow_deleted'
		       )
		  FROM executions e
		  JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		 WHERE e.id = $1::uuid
		 FOR UPDATE OF e
	`, executionID).Scan(&status, &deleted, &stopped)
	if err != nil {
		if errors.Is(mapDBErr(err), ErrNotFound) {
			return false, ErrClosed
		}
		return false, mapDBErr(err)
	}
	reason := ""
	switch {
	case status == "canceled":
		reason = ReasonRunCanceled
	case deleted || stopped:
		reason = ReasonWorkflowDeleted
	case status == "failed":
		return false, ErrClosed
	default:
		return false, nil
	}
	if err := closePendingApprovalsTx(ctx, tx, executionID, reason, now); err != nil {
		return false, err
	}
	return true, nil
}

func closePendingApprovalsTx(ctx context.Context, tx pgx.Tx, executionID, reason string, now time.Time) error {
	var n int
	err := tx.QueryRow(ctx, `SELECT app.close_pending_approvals($1::uuid, $2, $3)`, executionID, reason, now).Scan(&n)
	return mapDBErr(err)
}

type rowScanner interface {
	Scan(dest ...any) error
}

func actorArg(scope isolation.Scope) any {
	if scope.ActorID() == "" || !authz.ValidUUID(scope.ActorID()) {
		return nil
	}
	return scope.ActorID()
}

func nullUUID(id string) any {
	if !authz.ValidUUID(id) {
		return nil
	}
	return id
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}

func mapDBErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if errors.Is(err, postgres.ErrNoWorkspaceScope) {
		return ErrNoScope
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrConflict
		case "23503", "22P02", "42501":
			return ErrNotFound
		case "23514":
			return ErrInvalid
		}
	}
	return err
}
