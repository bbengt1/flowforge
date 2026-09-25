package wfstore

import (
	"context"
	"sort"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func peekJobTx(ctx context.Context, tx pgx.Tx, jobID string) (executionID, workflowID, status string, err error) {
	err = tx.QueryRow(ctx, `
		SELECT j.execution_id::text, e.workflow_id::text, j.status
		FROM execution_jobs j
		JOIN executions e ON e.workspace_id = j.workspace_id AND e.id = j.execution_id
		WHERE j.id = $1::uuid
	`, jobID).Scan(&executionID, &workflowID, &status)
	if err != nil {
		err = mapDBErr(err)
	}
	return executionID, workflowID, status, err
}

func closePendingApprovalsTx(ctx context.Context, tx pgx.Tx, executionID, reason string, now time.Time) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `SELECT app.close_pending_approvals($1::uuid, $2, $3)`, executionID, reason, now).Scan(&n)
	if err != nil {
		return 0, mapDBErr(err)
	}
	return n, nil
}

func lockExecutionTx(ctx context.Context, tx pgx.Tx, executionID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM executions WHERE id = $1::uuid FOR UPDATE`, executionID).Scan(&id)
	if err != nil {
		return mapDBErr(err)
	}
	return nil
}

// lockExecutionsSorted locks execution rows in id order before any job,
// step, or edge update in the same transaction. Callers that also lock a
// workflow take that lock first.
func lockExecutionsSorted(ctx context.Context, tx pgx.Tx, ids []string) error {
	seen := map[string]struct{}{}
	order := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		order = append(order, id)
	}
	sort.Strings(order)
	for _, id := range order {
		if err := lockExecutionTx(ctx, tx, id); err != nil {
			return err
		}
	}
	return nil
}

func resolveOutgoingTx(ctx context.Context, tx pgx.Tx, executionID, nodeID string, ports map[string]struct{}, now time.Time) error {
	if err := lockExecutionTx(ctx, tx, executionID); err != nil {
		return err
	}
	edges, err := loadEdgesTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	steps, err := loadStepsTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	jobs, err := loadJobsTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	beforeEdges := append([]execEdge(nil), edges...)
	beforeSteps := append([]ExecutionStep(nil), steps...)
	beforeJobs := append([]ExecutionJob(nil), jobs...)
	releaseFrom(steps, jobs, edges, nodeID, ports, now)
	return persistRunDiff(ctx, tx, beforeEdges, edges, beforeSteps, steps, beforeJobs, jobs)
}

func loadEdgesTx(ctx context.Context, tx pgx.Tx, executionID string) ([]execEdge, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, from_node, from_port, to_node, to_port, required, resolved, satisfied
		FROM execution_edges
		WHERE execution_id = $1::uuid
		ORDER BY from_node, from_port, to_node, to_port
	`, executionID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []execEdge
	for rows.Next() {
		var e execEdge
		if err := rows.Scan(&e.ID, &e.FromNode, &e.FromPort, &e.ToNode, &e.ToPort, &e.Required, &e.Resolved, &e.Satisfied); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func loadStepsTx(ctx context.Context, tx pgx.Tx, executionID string) ([]ExecutionStep, error) {
	rows, err := tx.Query(ctx, `SELECT `+stepColumns+` FROM execution_steps WHERE execution_id = $1::uuid`, executionID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []ExecutionStep
	for rows.Next() {
		step, err := scanStep(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, step)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func loadJobsTx(ctx context.Context, tx pgx.Tx, executionID string) ([]ExecutionJob, error) {
	rows, err := tx.Query(ctx, `SELECT `+jobColumns+` FROM execution_jobs WHERE execution_id = $1::uuid`, executionID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []ExecutionJob
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func persistRunDiff(ctx context.Context, tx pgx.Tx, beforeEdges, edges []execEdge, beforeSteps, steps []ExecutionStep, beforeJobs, jobs []ExecutionJob) error {
	for i := range edges {
		if i >= len(beforeEdges) {
			break
		}
		if beforeEdges[i].Resolved == edges[i].Resolved && beforeEdges[i].Satisfied == edges[i].Satisfied {
			continue
		}
		if beforeEdges[i].Resolved || !edges[i].Resolved {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE execution_edges
			SET resolved = true, satisfied = $2
			WHERE id = $1::uuid AND resolved = false
		`, edges[i].ID, edges[i].Satisfied); err != nil {
			return mapDBErr(err)
		}
	}
	for i := range steps {
		if i >= len(beforeSteps) {
			break
		}
		if beforeSteps[i].Status == steps[i].Status &&
			beforeSteps[i].UnresolvedIncoming == steps[i].UnresolvedIncoming &&
			sameTime(beforeSteps[i].FinishedAt, steps[i].FinishedAt) {
			continue
		}
		var finished any
		if steps[i].FinishedAt != nil {
			finished = *steps[i].FinishedAt
		}
		if _, err := tx.Exec(ctx, `
			UPDATE execution_steps
			SET status = $2,
			    unresolved_incoming = $3,
			    finished_at = $4,
			    updated_at = $5
			WHERE id = $1::uuid
		`, steps[i].ID, steps[i].Status, steps[i].UnresolvedIncoming, finished, steps[i].UpdatedAt); err != nil {
			return mapDBErr(err)
		}
	}
	for i := range jobs {
		if i >= len(beforeJobs) {
			break
		}
		if beforeJobs[i].Status == jobs[i].Status {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE execution_jobs
			SET status = $2,
			    available_at = CASE WHEN $2 = 'queued' THEN $3 ELSE available_at END,
			    updated_at = $3
			WHERE id = $1::uuid
			  AND status IN ('blocked', 'queued')
		`, jobs[i].ID, jobs[i].Status, jobs[i].UpdatedAt); err != nil {
			return mapDBErr(err)
		}
	}
	return nil
}

func (p *Postgres) AnnotateRetryCapabilities(ctx context.Context, scope isolation.Scope, exec *Execution, steps []ExecutionStep) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if exec == nil || !authz.ValidUUID(exec.ID) {
		return ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	edges, err := loadEdgesTx(ctx, tx, exec.ID)
	if err != nil {
		return err
	}
	var deleted bool
	if err := tx.QueryRow(ctx, `
		SELECT w.deleted_at IS NOT NULL
		FROM executions e
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE e.id = $1::uuid
	`, exec.ID).Scan(&deleted); err != nil {
		return mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapDBErr(err)
	}
	applyRetryCapabilities(exec, steps, edges, deleted)
	return nil
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
