package wfstore

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

func lockExecutionTx(ctx context.Context, tx pgx.Tx, executionID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM executions WHERE id = $1::uuid FOR UPDATE`, executionID).Scan(&id)
	if err != nil {
		return mapDBErr(err)
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

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
