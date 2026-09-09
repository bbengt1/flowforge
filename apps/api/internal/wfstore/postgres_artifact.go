package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const artifactColumns = `
	id::text,
	execution_id::text,
	COALESCE(execution_step_id::text, ''),
	kind,
	filename,
	content_type,
	digest,
	size_bytes,
	content_classification,
	redacted,
	expires_at,
	legal_hold,
	legal_hold_reason,
	COALESCE(legal_hold_by::text, ''),
	legal_hold_at,
	created_at,
	updated_at,
	storage_ref,
	dek_envelope,
	key_reference,
	encryption_version,
	metadata_ciphertext
`

func (p *Postgres) CreateArtifact(ctx context.Context, scope isolation.Scope, in CreateArtifactInput) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(in.ExecutionID) {
		return Artifact{}, ErrNotFound
	}
	if in.StepID != "" && !authz.ValidUUID(in.StepID) {
		return Artifact{}, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	exec, err := scanExecution(tx.QueryRow(ctx, `
		SELECT `+executionColumns+`
		FROM executions e
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE e.id = $1::uuid
	`, in.ExecutionID))
	if err != nil {
		return Artifact{}, err
	}
	if in.StepID != "" {
		if _, err := scanStep(tx.QueryRow(ctx, `
			SELECT `+strings.TrimSpace(stepColumns)+`
			FROM execution_steps
			WHERE execution_id = $1::uuid AND id = $2::uuid
		`, in.ExecutionID, in.StepID)); err != nil {
			return Artifact{}, err
		}
	}
	expires := in.ExpiresAt
	if expires.IsZero() {
		expires = exec.RetentionUntil
	}
	var step any
	if in.StepID != "" {
		step = in.StepID
	}
	art, err := scanArtifact(tx.QueryRow(ctx, `
		INSERT INTO execution_artifacts (
			workspace_id, execution_id, execution_step_id, kind, filename, content_type,
			storage_ref, digest, size_bytes, content_classification, redacted, expires_at,
			metadata_ciphertext, dek_envelope, key_reference, encryption_version
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12,
			$13, $14, $15, $16
		)
		RETURNING `+artifactColumns, scope.WorkspaceID(), in.ExecutionID, step, in.Kind, in.Filename, in.ContentType,
		in.StorageRef, in.Digest, in.SizeBytes, in.ContentClassification, in.Redacted, expires,
		in.MetadataCiphertext, in.DEKEnvelope, in.KeyReference, in.EncryptionVersion))
	if err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	return art, nil
}

func (p *Postgres) GetArtifact(ctx context.Context, scope isolation.Scope, artifactID string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(artifactID) {
		return Artifact{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	art, err := scanArtifact(tx.QueryRow(ctx, `SELECT `+artifactColumns+` FROM execution_artifacts WHERE id = $1::uuid`, artifactID))
	if err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	return art, nil
}

func (p *Postgres) ListArtifacts(ctx context.Context, scope isolation.Scope, filter ArtifactListFilter) ([]Artifact, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if filter.ExecutionID != "" && !authz.ValidUUID(filter.ExecutionID) {
		return nil, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if filter.ExecutionID != "" {
		if _, err := scanExecution(tx.QueryRow(ctx, `
			SELECT `+executionColumns+`
			FROM executions e
			JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
			WHERE e.id = $1::uuid
		`, filter.ExecutionID)); err != nil {
			return nil, err
		}
	}
	var execID any
	var stepID any
	if filter.ExecutionID != "" {
		execID = filter.ExecutionID
	}
	if filter.StepID != "" {
		stepID = filter.StepID
	}
	rows, err := tx.Query(ctx, `
		SELECT `+artifactColumns+`
		FROM execution_artifacts
		WHERE ($1::uuid IS NULL OR execution_id = $1::uuid)
		  AND ($2::uuid IS NULL OR execution_step_id = $2::uuid)
		  AND ($3 = '' OR kind = $3)
		ORDER BY created_at ASC
	`, execID, stepID, filter.Kind)
	if err != nil {
		return nil, mapDBErr(err)
	}
	out, err := collectArtifacts(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) DeleteArtifact(ctx context.Context, scope isolation.Scope, artifactID string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if !authz.ValidUUID(artifactID) {
		return ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	art, err := scanArtifact(tx.QueryRow(ctx, `SELECT `+artifactColumns+` FROM execution_artifacts WHERE id = $1::uuid`, artifactID))
	if err != nil {
		return err
	}
	if art.LegalHold {
		return ErrLegalHold
	}
	if _, err := tx.Exec(ctx, `DELETE FROM execution_artifacts WHERE id = $1::uuid`, artifactID); err != nil {
		return mapDBErr(err)
	}
	return mapDBErr(tx.Commit(ctx))
}

func (p *Postgres) SetLegalHold(ctx context.Context, scope isolation.Scope, artifactID string, in LegalHoldInput) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(artifactID) {
		return Artifact{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var art Artifact
	if in.Hold {
		art, err = scanArtifact(tx.QueryRow(ctx, `
			UPDATE execution_artifacts
			SET legal_hold = true,
			    legal_hold_reason = $2,
			    legal_hold_by = $3::uuid,
			    legal_hold_at = now(),
			    updated_at = now()
			WHERE id = $1::uuid
			RETURNING `+artifactColumns, artifactID, strings.TrimSpace(in.Reason), actorArg(scope)))
	} else {
		art, err = scanArtifact(tx.QueryRow(ctx, `
			UPDATE execution_artifacts
			SET legal_hold = false,
			    legal_hold_reason = '',
			    legal_hold_by = NULL,
			    legal_hold_at = NULL,
			    updated_at = now()
			WHERE id = $1::uuid
			RETURNING `+artifactColumns, artifactID))
	}
	if err != nil {
		return Artifact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	return art, nil
}

func (p *Postgres) CreateDownloadGrant(ctx context.Context, scope isolation.Scope, artifactID string, now time.Time, ttl time.Duration) (DownloadGrant, error) {
	if scope.Zero() {
		return DownloadGrant{}, ErrNoScope
	}
	if !authz.ValidUUID(artifactID) {
		return DownloadGrant{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if ttl <= 0 {
		ttl = DefaultDownloadTTL
	}
	if ttl > MaxDownloadTTL {
		ttl = MaxDownloadTTL
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DownloadGrant{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	art, err := scanArtifact(tx.QueryRow(ctx, `SELECT `+artifactColumns+` FROM execution_artifacts WHERE id = $1::uuid`, artifactID))
	if err != nil {
		return DownloadGrant{}, err
	}
	if !art.ExpiresAt.After(now) && !art.LegalHold {
		return DownloadGrant{}, ErrArtifactExpired
	}
	var grant DownloadGrant
	err = tx.QueryRow(ctx, `
		INSERT INTO artifact_download_grants (workspace_id, artifact_id, actor_id, expires_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
		RETURNING id::text, artifact_id::text, expires_at, COALESCE(actor_id::text, '')
	`, scope.WorkspaceID(), artifactID, actorArg(scope), now.Add(ttl)).Scan(&grant.ID, &grant.ArtifactID, &grant.ExpiresAt, &grant.ActorID)
	if err != nil {
		return DownloadGrant{}, mapDBErr(err)
	}
	grant.Href = "/api/v1/artifact-downloads/" + grant.ID
	grant.Method = "GET"
	if err := tx.Commit(ctx); err != nil {
		return DownloadGrant{}, mapDBErr(err)
	}
	return grant, nil
}

func (p *Postgres) GetDownloadGrant(ctx context.Context, scope isolation.Scope, grantID string, now time.Time) (DownloadGrant, Artifact, error) {
	if scope.Zero() {
		return DownloadGrant{}, Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(grantID) {
		return DownloadGrant{}, Artifact{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DownloadGrant{}, Artifact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var grant DownloadGrant
	err = tx.QueryRow(ctx, `
		SELECT id::text, artifact_id::text, expires_at, COALESCE(actor_id::text, '')
		FROM artifact_download_grants
		WHERE id = $1::uuid
	`, grantID).Scan(&grant.ID, &grant.ArtifactID, &grant.ExpiresAt, &grant.ActorID)
	if err != nil {
		return DownloadGrant{}, Artifact{}, mapDBErr(err)
	}
	if !grant.ExpiresAt.After(now) {
		return DownloadGrant{}, Artifact{}, ErrGrantExpired
	}
	art, err := scanArtifact(tx.QueryRow(ctx, `SELECT `+artifactColumns+` FROM execution_artifacts WHERE id = $1::uuid`, grant.ArtifactID))
	if err != nil {
		return DownloadGrant{}, Artifact{}, err
	}
	if !art.ExpiresAt.After(now) && !art.LegalHold {
		return DownloadGrant{}, Artifact{}, ErrArtifactExpired
	}
	grant.Href = "/api/v1/artifact-downloads/" + grant.ID
	grant.Method = "GET"
	if err := tx.Commit(ctx); err != nil {
		return DownloadGrant{}, Artifact{}, mapDBErr(err)
	}
	return grant, art, nil
}

func (p *Postgres) PlanRetentionPurge(ctx context.Context, scope isolation.Scope, now time.Time) (RetentionPlan, error) {
	if scope.Zero() {
		return RetentionPlan{}, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return RetentionPlan{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT `+artifactColumns+`
		FROM execution_artifacts
		WHERE expires_at <= $1
	`, now)
	if err != nil {
		return RetentionPlan{}, mapDBErr(err)
	}
	all, err := collectArtifacts(rows)
	if err != nil {
		return RetentionPlan{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RetentionPlan{}, mapDBErr(err)
	}
	var plan RetentionPlan
	for _, art := range all {
		if art.LegalHold {
			plan.Hold = append(plan.Hold, art)
			continue
		}
		plan.Purge = append(plan.Purge, art)
	}
	if plan.Purge == nil {
		plan.Purge = []Artifact{}
	}
	if plan.Hold == nil {
		plan.Hold = []Artifact{}
	}
	return plan, nil
}

func collectArtifacts(rows pgx.Rows) ([]Artifact, error) {
	defer rows.Close()
	var out []Artifact
	for rows.Next() {
		art, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, art)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Artifact{}
	}
	return out, nil
}

func scanArtifact(row rowScanner) (Artifact, error) {
	var art Artifact
	var holdAt *time.Time
	if err := row.Scan(
		&art.ID, &art.ExecutionID, &art.ExecutionStepID, &art.Kind, &art.Filename, &art.ContentType,
		&art.Digest, &art.SizeBytes, &art.ContentClassification, &art.Redacted, &art.ExpiresAt,
		&art.LegalHold, &art.LegalHoldReason, &art.LegalHoldBy, &holdAt, &art.CreatedAt, &art.UpdatedAt,
		&art.StorageRef, &art.DEKEnvelope, &art.KeyReference, &art.EncryptionVersion, &art.MetadataCiphertext,
	); err != nil {
		return Artifact{}, mapDBErr(err)
	}
	art.LegalHoldAt = holdAt
	return art, nil
}
