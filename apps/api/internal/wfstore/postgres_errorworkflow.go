package wfstore

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const latestVersionSQL = `
SELECT id::text, workflow_id::text, version_number, normalized_yaml, definition_digest,
       parsed_definition, publish_note, COALESCE(published_by::text, ''), published_at, catalog_revision
FROM workflow_versions
WHERE workspace_id = $1::uuid AND workflow_id = $2::uuid
ORDER BY version_number DESC
LIMIT 1
`

// GetErrorWorkflow returns the workspace's configured error workflow.
func (p *Postgres) GetErrorWorkflow(ctx context.Context, scope isolation.Scope) (ErrorWorkflowSetting, bool, error) {
	if scope.Zero() {
		return ErrorWorkflowSetting{}, false, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return ErrorWorkflowSetting{}, false, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var out ErrorWorkflowSetting
	err = tx.QueryRow(ctx, `
		SELECT ws.error_workflow_id::text, COALESCE(w.name, ''), COALESCE(w.slug, '')
		  FROM workspaces ws
		  LEFT JOIN workflows w ON w.workspace_id = ws.id AND w.id = ws.error_workflow_id
		 WHERE ws.id = $1::uuid AND ws.error_workflow_id IS NOT NULL
	`, scope.WorkspaceID()).Scan(&out.WorkflowID, &out.WorkflowName, &out.WorkflowSlug)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrorWorkflowSetting{}, false, nil
	}
	if err != nil {
		return ErrorWorkflowSetting{}, false, mapDBErr(err)
	}
	return out, true, nil
}

// SetErrorWorkflow names the workspace error workflow. The target must be
// a live, published workflow in the scope's workspace (RLS plus the
// composite FK) whose latest version's only trigger is `error`.
func (p *Postgres) SetErrorWorkflow(ctx context.Context, scope isolation.Scope, workflowID string, actor AuditActor) (ErrorWorkflowSetting, error) {
	if err := adminScope(scope); err != nil {
		return ErrorWorkflowSetting{}, err
	}
	workflowID = strings.TrimSpace(workflowID)
	if !authz.ValidUUID(workflowID) {
		return ErrorWorkflowSetting{}, ErrErrorWorkflowTarget
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return ErrorWorkflowSetting{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var previous string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(error_workflow_id::text, '') FROM workspaces WHERE id = $1::uuid FOR NO KEY UPDATE
	`, scope.WorkspaceID()).Scan(&previous); err != nil {
		return ErrorWorkflowSetting{}, mapDBErr(err)
	}
	var wf Workflow
	var status string
	var deleted bool
	err = tx.QueryRow(ctx, `
		SELECT id::text, name, slug, status, deleted_at IS NOT NULL
		  FROM workflows WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, scope.WorkspaceID(), workflowID).Scan(&wf.ID, &wf.Name, &wf.Slug, &status, &deleted)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrorWorkflowSetting{}, ErrErrorWorkflowTarget
		}
		return ErrorWorkflowSetting{}, mapDBErr(err)
	}
	var ver *Version
	if v, verr := scanVersion(tx.QueryRow(ctx, latestVersionSQL, scope.WorkspaceID(), workflowID)); verr == nil {
		ver = &v
	} else if !errors.Is(verr, ErrNotFound) {
		return ErrorWorkflowSetting{}, verr
	}
	if errorTargetSkip(true, deleted, status, ver) != "" {
		return ErrorWorkflowSetting{}, ErrErrorWorkflowTarget
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspaces SET error_workflow_id = $2::uuid, updated_at = now() WHERE id = $1::uuid
	`, scope.WorkspaceID(), workflowID); err != nil {
		return ErrorWorkflowSetting{}, mapDBErr(err)
	}
	if _, err := insertAuditTx(ctx, tx, scope, errorWorkflowSetAudit(scope, actor, wf, previous)); err != nil {
		return ErrorWorkflowSetting{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrorWorkflowSetting{}, mapDBErr(err)
	}
	return ErrorWorkflowSetting{WorkflowID: wf.ID, WorkflowName: wf.Name, WorkflowSlug: wf.Slug}, nil
}

// ClearErrorWorkflow removes the workspace error workflow. Clearing an
// unset one is a no-op (false, no audit row).
func (p *Postgres) ClearErrorWorkflow(ctx context.Context, scope isolation.Scope, actor AuditActor) (bool, error) {
	if err := adminScope(scope); err != nil {
		return false, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return false, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var previous string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(error_workflow_id::text, '') FROM workspaces WHERE id = $1::uuid FOR NO KEY UPDATE
	`, scope.WorkspaceID()).Scan(&previous); err != nil {
		return false, mapDBErr(err)
	}
	if previous == "" {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspaces SET error_workflow_id = NULL, updated_at = now() WHERE id = $1::uuid
	`, scope.WorkspaceID()); err != nil {
		return false, mapDBErr(err)
	}
	if _, err := insertAuditTx(ctx, tx, scope, errorWorkflowClearedAudit(scope, actor, previous)); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, mapDBErr(err)
	}
	return true, nil
}

// fireErrorWorkflowTx runs in the rollup transaction right after a run's
// status moved from prev.Status to next. The whole fire path runs in a
// savepoint: any error rolls back only the savepoint, is audited as a
// start_failed skip, and is never returned, so the parent's final status
// always commits. It starts at most one error run per parent (partial
// unique index). The caller holds the parent execution row lock.
func fireErrorWorkflowTx(ctx context.Context, tx pgx.Tx, prev Execution, next string, now time.Time) error {
	if prev.Status == next || (next != ExecutionFailed && next != ExecutionIndeterminate) {
		return nil
	}
	sp, err := tx.Begin(ctx)
	if err != nil {
		return nil // cannot isolate the fire path; never block the parent
	}
	ws, target, ferr := fireErrorWorkflowInTx(ctx, sp, prev, next, now)
	if ferr == nil {
		if ferr = sp.Commit(ctx); ferr == nil {
			return nil
		}
	}
	_ = sp.Rollback(ctx)
	auditStartFailedTx(ctx, tx, ws, target, prev)
	return nil
}

// auditStartFailedTx records a start_failed skip in its own savepoint; a
// failure here is dropped so it cannot abort the parent's rollup.
func auditStartFailedTx(ctx context.Context, tx pgx.Tx, ws, target string, prev Execution) {
	if ws == "" {
		return
	}
	sys, err := isolation.AuthorizeSystem(ws)
	if err != nil {
		return
	}
	sp, err := tx.Begin(ctx)
	if err != nil {
		return
	}
	if _, err := insertAuditTx(ctx, sp, sys, errorSkippedAudit(prev, target, ErrorSkipStartFailed)); err != nil {
		_ = sp.Rollback(ctx)
		return
	}
	_ = sp.Commit(ctx)
}

// fireErrorWorkflowInTx is the fire path proper. tx is the savepoint. It
// returns the workspace and target it resolved so the caller can audit.
func fireErrorWorkflowInTx(ctx context.Context, tx pgx.Tx, prev Execution, next string, now time.Time) (ws, target string, err error) {
	var errorParent string
	var retried, parentDeleted bool
	if err := tx.QueryRow(ctx, `
		SELECT e.workspace_id::text, COALESCE(e.error_parent_id::text, ''), e.operator_retried_at IS NOT NULL,
		       w.deleted_at IS NOT NULL, COALESCE(ws.error_workflow_id::text, '')
		  FROM executions e
		  JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		  JOIN workspaces ws ON ws.id = e.workspace_id
		 WHERE e.id = $1::uuid
	`, prev.ID).Scan(&ws, &errorParent, &retried, &parentDeleted, &target); err != nil {
		return "", "", mapDBErr(err)
	}
	if target == "" || parentDeleted || !errorParentEligible(ExecutionTriggerType(prev), errorParent, retried) {
		return ws, target, nil
	}
	sys, err := isolation.AuthorizeSystem(ws)
	if err != nil {
		return ws, target, err
	}
	steps, err := loadStepsTx(ctx, tx, prev.ID)
	if err != nil {
		return ws, target, err
	}
	var pinnedYAML string
	var pinnedNumber int
	if err := tx.QueryRow(ctx, `
		SELECT normalized_yaml, version_number FROM workflow_versions WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, ws, prev.WorkflowVersionID).Scan(&pinnedYAML, &pinnedNumber); err != nil {
		return ws, target, mapDBErr(err)
	}
	fire, reason, skip, cause := errorWorkflowDecision(next, steps, pinnedYAML)
	if !fire {
		if skip == "" {
			return ws, target, nil
		}
		_, err := insertAuditTx(ctx, tx, sys, errorSkippedAudit(prev, target, skip))
		return ws, target, err
	}
	var status string
	var deleted bool
	found := true
	if err := tx.QueryRow(ctx, `
		SELECT status, deleted_at IS NOT NULL FROM workflows WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, ws, target).Scan(&status, &deleted); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return ws, target, mapDBErr(err)
		}
		found = false
	}
	var ver *Version
	if found {
		if v, verr := scanVersion(tx.QueryRow(ctx, latestVersionSQL, ws, target)); verr == nil {
			ver = &v
		} else if !errors.Is(verr, ErrNotFound) {
			return ws, target, verr
		}
	}
	if skip := errorTargetSkip(found, deleted, status, ver); skip != "" {
		_, err := insertAuditTx(ctx, tx, sys, errorSkippedAudit(prev, target, skip))
		return ws, target, err
	}
	if skip := gateErrorRunTx(ctx, tx, sys, *ver); skip != "" {
		_, err := insertAuditTx(ctx, tx, sys, errorSkippedAudit(prev, target, skip))
		return ws, target, err
	}
	payload, err := boundInput(errorWorkflowPayload(prev, pinnedNumber, reason, cause))
	if err != nil {
		return ws, target, err
	}
	inputRaw, err := marshalObject(redactObject(payload))
	if err != nil {
		return ws, target, ErrInvalid
	}
	policyRaw, err := marshalObject(errorRunPolicy(*ver))
	if err != nil {
		return ws, target, ErrInvalid
	}
	if cerr := enforceOpenCap(ctx, tx, ws, errorWorkflowOpenCap()); errors.Is(cerr, ErrConcurrency) {
		_, err := insertAuditTx(ctx, tx, sys, errorSkippedAudit(prev, target, ErrorSkipCapReached))
		return ws, target, err
	} else if cerr != nil {
		return ws, target, cerr
	}
	child, err := scanExecution(tx.QueryRow(ctx, `
		INSERT INTO executions (
			workspace_id, workflow_id, workflow_version_id, workflow_digest, status,
			input_redacted, policy_snapshot, correlation_id, requested_by, started_at,
			retention_until, error_parent_id
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, 'queued',
			$5::jsonb, $6::jsonb, NULLIF($7, ''), NULL, $8::timestamptz,
			$8::timestamptz + interval '90 days', $9::uuid
		)
		ON CONFLICT (workspace_id, error_parent_id) WHERE error_parent_id IS NOT NULL DO NOTHING
		RETURNING `+executionInsertReturning+`
	`, ws, target, ver.ID, ver.Digest, inputRaw, policyRaw, prev.CorrelationID, now, prev.ID))
	if errors.Is(err, ErrNotFound) {
		return ws, target, nil // already fired for this parent
	}
	if err != nil {
		return ws, target, err
	}
	if err := errorFireFault(); err != nil {
		return ws, target, err
	}
	nodes, edges, err := planGraph(ver.DefinitionYAML, ver.Summary)
	if err != nil {
		return ws, target, err
	}
	if err := insertPlanTx(ctx, tx, sys, child.ID, nodes, edges); err != nil {
		return ws, target, err
	}
	if _, err := tx.Exec(ctx, `UPDATE executions SET error_fired_at = $2 WHERE id = $1::uuid`, prev.ID, now); err != nil {
		return ws, target, mapDBErr(err)
	}
	if _, err := insertAuditTx(ctx, tx, sys, AuditWrite{
		Action:        "execution.start",
		ResourceType:  "execution",
		ResourceID:    child.ID,
		Outcome:       "created",
		CorrelationID: child.CorrelationID,
		Details:       startAuditDetails(target, *ver, child, "created"),
	}); err != nil {
		return ws, target, err
	}
	_, err = insertAuditTx(ctx, tx, sys, errorFiredAudit(prev, child, target, reason, cause))
	return ws, target, err
}

// gateErrorRunTx runs the policy gate inside a savepoint, so a failed
// read can never abort the rollup transaction. Fail closed.
func gateErrorRunTx(ctx context.Context, tx pgx.Tx, sys isolation.Scope, ver Version) string {
	gate := currentErrorGate()
	if gate == nil {
		return ErrorSkipPolicyUnavailable
	}
	sp, err := tx.Begin(ctx)
	if err != nil {
		return ErrorSkipPolicyUnavailable
	}
	defer sp.Rollback(ctx)
	return gate(ctx, sp, sys, ver)
}
