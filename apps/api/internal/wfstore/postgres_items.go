package wfstore

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

var _ ItemStore = (*Postgres)(nil)

// PutStepItems writes every items port of one step, the bounded summary,
// the run budget, and one counts-only audit row in one transaction. Lock
// order follows lockExecutionsSorted: the executions row is locked before
// any step or item write. A cap breach rolls everything back.
func (p *Postgres) PutStepItems(ctx context.Context, scope isolation.Scope, in PutStepItemsInput) (PutStepItemsResult, error) {
	if scope.Zero() {
		return PutStepItemsResult{}, ErrNoScope
	}
	prep, err := prepareItems(in)
	if err != nil {
		return PutStepItemsResult{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return PutStepItemsResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := lockExecutionsSorted(ctx, tx, []string{in.ExecutionID}); err != nil {
		return PutStepItemsResult{}, err
	}
	step, err := scanStep(tx.QueryRow(ctx, `
		SELECT `+stepColumns+`
		FROM execution_steps
		WHERE execution_id = $1::uuid AND id = $2::uuid
		FOR UPDATE
	`, in.ExecutionID, in.StepID))
	if err != nil {
		return PutStepItemsResult{}, err
	}
	// M2: write-once is tracked in its own column, not in output keys.
	var written bool
	if err := tx.QueryRow(ctx, `
		SELECT items_written_at IS NOT NULL FROM execution_steps
		WHERE execution_id = $1::uuid AND id = $2::uuid
	`, in.ExecutionID, in.StepID).Scan(&written); err != nil {
		return PutStepItemsResult{}, mapDBErr(err)
	}
	if written {
		return PutStepItemsResult{}, ErrConflict
	}
	merged, err := buildItemsOutput(step.Output, prep)
	if err != nil {
		return PutStepItemsResult{}, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE executions
		   SET item_bytes = item_bytes + $2
		 WHERE id = $1::uuid
		   AND item_bytes + $2 <= $3
	`, in.ExecutionID, prep.bytes, int64(workflow.MaxRunItemBytes))
	if err != nil {
		return PutStepItemsResult{}, mapDBErr(err)
	}
	if tag.RowsAffected() != 1 {
		return PutStepItemsResult{}, &ItemCapError{Code: ItemCodeRunBudgetExceeded}
	}
	for _, port := range prep.ports {
		for _, it := range port.items {
			if _, err := tx.Exec(ctx, `
				INSERT INTO execution_step_items (workspace_id, step_id, port, idx, item_redacted, bytes, lineage)
				VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::jsonb)
			`, scope.WorkspaceID(), in.StepID, it.port, it.idx, it.raw, len(it.raw), it.linRaw); err != nil {
				return PutStepItemsResult{}, mapDBErr(err)
			}
		}
	}
	outRaw, err := marshalObject(merged)
	if err != nil {
		return PutStepItemsResult{}, ErrInvalid
	}
	if tag, err := tx.Exec(ctx, `
		UPDATE execution_steps SET output_redacted = $3::jsonb, items_written_at = now(), updated_at = now()
		WHERE execution_id = $1::uuid AND id = $2::uuid AND items_written_at IS NULL
	`, in.ExecutionID, in.StepID, outRaw); err != nil {
		return PutStepItemsResult{}, mapDBErr(err)
	} else if tag.RowsAffected() != 1 {
		return PutStepItemsResult{}, ErrConflict
	}
	if _, err := insertAuditTx(ctx, tx, scope, itemsAudit(step, prep)); err != nil {
		return PutStepItemsResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PutStepItemsResult{}, mapDBErr(err)
	}
	return PutStepItemsResult{Count: prep.count, Bytes: prep.bytes}, nil
}

// ListStepItems returns one page of redacted items under RLS. A step in
// another workspace is ErrNotFound.
func (p *Postgres) ListStepItems(ctx context.Context, scope isolation.Scope, q StepItemsQuery) (StepItemsPage, error) {
	if scope.Zero() {
		return StepItemsPage{}, ErrNoScope
	}
	q, err := normalizeItemsQuery(q)
	if err != nil {
		return StepItemsPage{}, err
	}
	step, err := p.GetStep(ctx, scope, q.ExecutionID, q.StepID)
	if err != nil {
		return StepItemsPage{}, err
	}
	total, ok := itemsSummaryCount(step.Output, q.Port)
	if !ok {
		return singleItemPage(step, q), nil
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return StepItemsPage{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT i.idx, i.item_redacted, i.lineage
		FROM execution_step_items i
		JOIN execution_steps s ON s.workspace_id = i.workspace_id AND s.id = i.step_id
		WHERE s.execution_id = $1::uuid AND i.step_id = $2::uuid AND i.port = $3 AND i.idx > $4
		ORDER BY i.idx
		LIMIT $5
	`, q.ExecutionID, q.StepID, q.Port, q.AfterIdx, q.Limit+1)
	if err != nil {
		return StepItemsPage{}, mapDBErr(err)
	}
	defer rows.Close()
	page := StepItemsPage{Items: []StepItem{}, Total: total, Next: -1}
	for rows.Next() {
		var it StepItem
		var itemRaw, linRaw []byte
		if err := rows.Scan(&it.Idx, &itemRaw, &linRaw); err != nil {
			return StepItemsPage{}, mapDBErr(err)
		}
		it.Item = unmarshalObject(itemRaw)
		it.Lineage = unmarshalObject(linRaw)
		page.Items = append(page.Items, it)
	}
	if err := rows.Err(); err != nil {
		return StepItemsPage{}, mapDBErr(err)
	}
	if len(page.Items) > q.Limit {
		page.Items = page.Items[:q.Limit]
		page.Next = page.Items[len(page.Items)-1].Idx
	}
	if err := tx.Commit(ctx); err != nil {
		return StepItemsPage{}, mapDBErr(err)
	}
	return page, nil
}

// itemsAudit is the counts-only step.items_completed row. It never carries
// item values.
func itemsAudit(step ExecutionStep, prep preparedItems) AuditWrite {
	return AuditWrite{
		Action:       ActionStepItemsCompleted,
		ResourceType: "execution",
		ResourceID:   step.ExecutionID,
		Outcome:      "completed",
		Details: map[string]any{
			"stepId":        step.ID,
			"nodeId":        step.NodeID,
			"attempt":       step.Attempt,
			"ports":         len(prep.ports),
			"count":         prep.count,
			"failed":        0,
			"indeterminate": 0,
			"bytes":         prep.bytes,
		},
	}
}
