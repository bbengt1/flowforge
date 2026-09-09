package scripts

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Postgres persists script artifacts under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

const artifactColumns = `
	a.id::text, a.language, a.entrypoint, a.digest, a.signature, a.scan_status, a.status,
	COALESCE(a.runtime_profile_id::text, ''), COALESCE(a.runtime_profile_version_id::text, ''),
	COALESCE(a.runtime_profile_digest, ''), a.source_bytes, a.metadata,
	COALESCE(a.created_by::text, ''), a.created_at, a.revoked_at, COALESCE(a.revoked_by::text, ''), a.storage_ref
`

func (p *Postgres) Put(ctx context.Context, scope isolation.Scope, art Artifact) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if art.Status != "" && art.Status != StatusPublished {
		return Artifact{}, ErrMutable
	}
	if art.ScanStatus != ScanClean || strings.TrimSpace(art.Signature) == "" {
		return Artifact{}, ErrUnscanned
	}
	meta, err := json.Marshal(art.Metadata)
	if err != nil || art.Metadata == nil {
		meta = []byte("{}")
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	existing, err := scanArtifact(tx.QueryRow(ctx, `
		SELECT `+artifactColumns+` FROM script_artifacts a WHERE a.digest = $1
	`, art.Digest))
	if err == nil {
		if existing.Status != StatusPublished {
			return Artifact{}, ErrMutable
		}
		return existing, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Artifact{}, err
	}

	createdBy := nullUUID(scope.ActorID())
	row := tx.QueryRow(ctx, `
		INSERT INTO script_artifacts (
			workspace_id, language, entrypoint, digest, signature, scan_status, status,
			runtime_profile_id, runtime_profile_version_id, runtime_profile_digest,
			source_bytes, metadata, created_by, storage_ref, package_blob
		) VALUES (
			$1::uuid, $2, $3, $4, $5, $6, 'published',
			NULLIF($7, '')::uuid, NULLIF($8, '')::uuid, NULLIF($9, ''),
			$10, $11::jsonb, $12, $13, $14
		)
		RETURNING
			id::text, language, entrypoint, digest, signature, scan_status, status,
			COALESCE(runtime_profile_id::text, ''), COALESCE(runtime_profile_version_id::text, ''),
			COALESCE(runtime_profile_digest, ''), source_bytes, metadata,
			COALESCE(created_by::text, ''), created_at, revoked_at, COALESCE(revoked_by::text, ''), storage_ref
	`, scope.WorkspaceID(), art.Language, art.Entrypoint, art.Digest, art.Signature, ScanClean,
		art.RuntimeProfileID, art.RuntimeProfileVersionID, art.RuntimeProfileDigest,
		art.SourceBytes, meta, createdBy, art.StorageRef, art.Package)
	out, err := scanArtifactBare(row)
	if err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, id string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Artifact{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	art, err := scanArtifact(tx.QueryRow(ctx, `
		SELECT `+artifactColumns+` FROM script_artifacts a WHERE a.id = $1::uuid
	`, id))
	if err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	return art, nil
}

func (p *Postgres) GetByDigest(ctx context.Context, scope isolation.Scope, digest string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	art, err := scanArtifact(tx.QueryRow(ctx, `
		SELECT `+artifactColumns+` FROM script_artifacts a WHERE a.digest = $1
	`, digest))
	if err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	return art, nil
}

func (p *Postgres) BindVersion(ctx context.Context, scope isolation.Scope, workflowVersionID string, pins []VersionPin) ([]VersionPin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(workflowVersionID) {
		return nil, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var existing int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM workflow_version_artifacts WHERE workflow_version_id = $1::uuid
	`, workflowVersionID).Scan(&existing); err != nil {
		return nil, mapDBErr(err)
	}
	if existing > 0 {
		return nil, ErrImmutable
	}
	out := make([]VersionPin, 0, len(pins))
	for _, pin := range pins {
		pin.WorkflowVersionID = workflowVersionID
		if _, err := tx.Exec(ctx, `
			INSERT INTO workflow_version_artifacts (
				workspace_id, workflow_version_id, node_id, node_type, script_artifact_id, digest
			) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
		`, scope.WorkspaceID(), workflowVersionID, pin.NodeID, pin.NodeType, pin.ArtifactID, pin.Digest); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, pin)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []VersionPin{}
	}
	return out, nil
}

func (p *Postgres) ListVersionPins(ctx context.Context, scope isolation.Scope, workflowVersionID string) ([]VersionPin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT p.workflow_version_id::text, p.node_id, COALESCE(p.node_type, ''),
			p.script_artifact_id::text, p.digest, a.scan_status, a.signature, a.language, a.entrypoint
		FROM workflow_version_artifacts p
		JOIN script_artifacts a ON a.id = p.script_artifact_id AND a.workspace_id = p.workspace_id
		WHERE p.workflow_version_id = $1::uuid
		ORDER BY p.node_id
	`, workflowVersionID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []VersionPin
	for rows.Next() {
		var pin VersionPin
		if err := rows.Scan(&pin.WorkflowVersionID, &pin.NodeID, &pin.NodeType, &pin.ArtifactID, &pin.Digest, &pin.ScanStatus, &pin.Signature, &pin.Language, &pin.Entrypoint); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, pin)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []VersionPin{}
	}
	return out, nil
}

func (p *Postgres) Revoke(ctx context.Context, scope isolation.Scope, id string, now time.Time, actorID, reason string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Artifact{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	patch := map[string]any{}
	if reason != "" {
		patch["revokeReason"] = reason
	}
	if actorID != "" {
		patch["revokedBy"] = actorID
	}
	raw, err := json.Marshal(patch)
	if err != nil || len(patch) == 0 {
		raw = []byte("{}")
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	art, err := scanArtifactBare(tx.QueryRow(ctx, `
		UPDATE script_artifacts
		   SET revoked_at = COALESCE(revoked_at, $2),
		       revoked_by = COALESCE(revoked_by, NULLIF($3, '')::uuid),
		       metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
		 WHERE id = $1::uuid
		 RETURNING
			id::text, language, entrypoint, digest, signature, scan_status, status,
			COALESCE(runtime_profile_id::text, ''), COALESCE(runtime_profile_version_id::text, ''),
			COALESCE(runtime_profile_digest, ''), source_bytes, metadata,
			COALESCE(created_by::text, ''), created_at, revoked_at, COALESCE(revoked_by::text, ''), storage_ref
	`, id, now, nullUUID(actorID), raw))
	if err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	return art, nil
}

func scanArtifact(row pgx.Row) (Artifact, error) {
	return scanArtifactBare(row)
}

func scanArtifactBare(row pgx.Row) (Artifact, error) {
	var art Artifact
	var meta []byte
	var revoked *time.Time
	err := row.Scan(
		&art.ID, &art.Language, &art.Entrypoint, &art.Digest, &art.Signature, &art.ScanStatus, &art.Status,
		&art.RuntimeProfileID, &art.RuntimeProfileVersionID, &art.RuntimeProfileDigest,
		&art.SourceBytes, &meta, &art.CreatedBy, &art.CreatedAt, &revoked, &art.RevokedBy, &art.StorageRef,
	)
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	art.RevokedAt = revoked
	if len(meta) > 0 {
		_ = json.Unmarshal(meta, &art.Metadata)
	}
	if art.Metadata == nil {
		art.Metadata = map[string]any{}
	}
	return art, nil
}

func nullUUID(id string) any {
	if !authz.ValidUUID(id) {
		return nil
	}
	return id
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
		case "25006":
			return ErrImmutable
		}
	}
	return err
}
