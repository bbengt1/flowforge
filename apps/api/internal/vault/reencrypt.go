package vault

import (
	"context"
	"errors"
	"fmt"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const reencryptBatchSize = 100

// ReencryptStats counts envelopes whose DEK was rewrapped under the
// active KEK. It contains no key material.
type ReencryptStats struct {
	Workspaces  int
	Credentials int
	Artifacts   int
}

// ReencryptAll rewraps credential and artifact DEKs that are not already
// on the active key. Each workspace runs in its own transaction with
// app.workspace_id set, so FORCE RLS still applies. Secret ciphertext
// is not rewritten and is not loaded. A row that cannot be opened stops
// the run so the previous KEK is not retired over undecryptable data.
func ReencryptAll(ctx context.Context, db DB, keys Keys) (ReencryptStats, error) {
	if !keys.Ready() {
		return ReencryptStats{}, ErrKeyUnavailable
	}
	rows, err := db.Query(ctx, `SELECT id::text FROM workspaces ORDER BY id`)
	if err != nil {
		return ReencryptStats{}, mapDBErr(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return ReencryptStats{}, mapDBErr(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return ReencryptStats{}, mapDBErr(err)
	}
	var stats ReencryptStats
	for _, id := range ids {
		cred, art, err := reencryptWorkspace(ctx, db, id, keys)
		if err != nil {
			return stats, err
		}
		if cred > 0 || art > 0 {
			stats.Workspaces++
		}
		stats.Credentials += cred
		stats.Artifacts += art
	}
	return stats, nil
}

func reencryptWorkspace(ctx context.Context, db DB, workspaceID string, keys Keys) (credentials, artifacts int, err error) {
	credentials, err = reencryptRelation(ctx, db, workspaceID, keys,
		`SELECT id::text, dek_envelope, key_reference, encryption_version
		 FROM credentials
		 WHERE key_reference IS DISTINCT FROM $1
		 ORDER BY id
		 LIMIT $2`,
		`UPDATE credentials
		 SET dek_envelope = $2, key_reference = $3, encryption_version = $4, updated_at = now()
		 WHERE id = $1::uuid`)
	if err != nil {
		return credentials, 0, err
	}
	artifacts, err = reencryptRelation(ctx, db, workspaceID, keys,
		`SELECT id::text, dek_envelope, key_reference, encryption_version
		 FROM execution_artifacts
		 WHERE key_reference IS DISTINCT FROM $1
		 ORDER BY id
		 LIMIT $2`,
		`UPDATE execution_artifacts
		 SET dek_envelope = $2, key_reference = $3, encryption_version = $4, updated_at = now()
		 WHERE id = $1::uuid`)
	return credentials, artifacts, err
}

func reencryptRelation(ctx context.Context, db DB, workspaceID string, keys Keys, selectSQL, updateSQL string) (int, error) {
	updated := 0
	for {
		tx, err := postgres.BeginScoped(ctx, db, workspaceID)
		if err != nil {
			return updated, mapDBErr(err)
		}
		n, err := reencryptBatch(ctx, tx, keys, selectSQL, updateSQL)
		if err != nil {
			_ = tx.Rollback(ctx)
			if errors.Is(err, ErrDecrypt) || errors.Is(err, ErrInvalid) || errors.Is(err, ErrKeyUnavailable) {
				return updated, fmt.Errorf("rewrap stopped in workspace %s: %w", workspaceID, err)
			}
			return updated, fmt.Errorf("rewrap stopped in workspace %s", workspaceID)
		}
		if err := tx.Commit(ctx); err != nil {
			return updated, mapDBErr(err)
		}
		updated += n
		if n < reencryptBatchSize {
			return updated, nil
		}
	}
}

func reencryptBatch(ctx context.Context, tx pgx.Tx, keys Keys, selectSQL, updateSQL string) (int, error) {
	rows, err := tx.Query(ctx, selectSQL, keys.ID, reencryptBatchSize)
	if err != nil {
		return 0, err
	}
	type item struct {
		id  string
		env Envelope
	}
	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.env.DEKEnvelope, &it.env.KeyRef, &it.env.Version); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for _, it := range items {
		out, _, err := RewrapDEK(keys, it.env)
		if err != nil {
			return 0, err
		}
		if out.KeyRef == it.env.KeyRef {
			return 0, ErrInvalid
		}
		if _, err := tx.Exec(ctx, updateSQL, it.id, out.DEKEnvelope, out.KeyRef, out.Version); err != nil {
			return 0, err
		}
	}
	return len(items), nil
}
