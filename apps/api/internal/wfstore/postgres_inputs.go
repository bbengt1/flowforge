package wfstore

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// resolveInputsTx loads edges and the latest succeeded redacted output for
// the claimed node's upstream nodes. Both statements are plain SELECTs
// under the claim transaction's existing locks. They take no FOR UPDATE
// and add no lock. Only redacted columns are read. A node with no incoming
// edges returns before the steps query.
func resolveInputsTx(ctx context.Context, tx pgx.Tx, executionID, nodeID string) (map[string]any, []SkippedInput, error) {
	edges, err := loadEdgesTx(ctx, tx, executionID)
	if err != nil {
		return nil, nil, err
	}
	ids := upstreamNodeIDs(nodeID, edges)
	if len(ids) == 0 {
		inputs, skipped := resolveInputs(nodeID, edges, nil)
		return inputs, skipped, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (node_id) node_id, node_type, input_redacted, output_redacted
		FROM execution_steps
		WHERE execution_id = $1::uuid AND status = 'succeeded' AND node_id = ANY($2::text[])
		ORDER BY node_id, attempt DESC
	`, executionID, ids)
	if err != nil {
		return nil, nil, mapDBErr(err)
	}
	defer rows.Close()
	snaps := map[string]succeededSnap{}
	for rows.Next() {
		var id, nodeType string
		var inputRaw, outputRaw []byte
		if err := rows.Scan(&id, &nodeType, &inputRaw, &outputRaw); err != nil {
			return nil, nil, mapDBErr(err)
		}
		snaps[id] = succeededSnap{
			NodeType: nodeType,
			With:     unmarshalObject(inputRaw),
			Output:   unmarshalObject(outputRaw),
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, mapDBErr(err)
	}
	inputs, skipped := resolveInputs(nodeID, edges, snaps)
	return inputs, skipped, nil
}
