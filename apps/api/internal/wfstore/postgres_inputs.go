package wfstore

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// resolveInputsTx loads edges and the latest succeeded output_redacted for
// one claim. Both statements are plain SELECTs under the claim transaction's
// existing locks. They take no FOR UPDATE and add no lock. Only the redacted
// column is read.
func resolveInputsTx(ctx context.Context, tx pgx.Tx, executionID, nodeID string) (map[string]any, []SkippedInput, error) {
	edges, err := loadEdgesTx(ctx, tx, executionID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (node_id) node_id, node_type, output_redacted
		FROM execution_steps
		WHERE execution_id = $1::uuid AND status = 'succeeded'
		ORDER BY node_id, attempt DESC
	`, executionID)
	if err != nil {
		return nil, nil, mapDBErr(err)
	}
	defer rows.Close()
	snaps := map[string]succeededSnap{}
	for rows.Next() {
		var id, nodeType string
		var raw []byte
		if err := rows.Scan(&id, &nodeType, &raw); err != nil {
			return nil, nil, mapDBErr(err)
		}
		snaps[id] = succeededSnap{NodeType: nodeType, Output: unmarshalObject(raw)}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, mapDBErr(err)
	}
	inputs, skipped := resolveInputs(nodeID, edges, snaps)
	return inputs, skipped, nil
}
