package vault

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
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

// Postgres persists envelope-encrypted credentials under FORCE RLS.
type Postgres struct {
	db   DB
	keys Keys
	refs RefFinder
	now  func() time.Time
}

// NewPostgres returns a PostgreSQL-backed vault.
func NewPostgres(db DB, keys Keys, refs RefFinder) *Postgres {
	return &Postgres{db: db, keys: keys, refs: refs, now: func() time.Time { return time.Now().UTC() }}
}

func (p *Postgres) Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Metadata, error) {
	if scope.Zero() {
		return Metadata{}, ErrNoScope
	}
	plain, fp, meta, err := prepareCreate(in)
	if err != nil {
		return Metadata{}, err
	}
	env, err := Encrypt(p.keys, plain)
	if err != nil {
		return Metadata{}, err
	}
	tags, err := json.Marshal(meta.Tags)
	if err != nil {
		return Metadata{}, ErrInvalid
	}
	md, err := json.Marshal(meta.Metadata)
	if err != nil {
		return Metadata{}, ErrInvalid
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Metadata{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	out, err := scanMeta(tx.QueryRow(ctx, `
		INSERT INTO credentials (
			workspace_id, type, display_name, ciphertext, dek_envelope, key_reference,
			encryption_version, metadata, tags, fingerprint, status, expires_at, created_by, updated_by
		) VALUES (
			$1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, 'active', $11, $12::uuid, $12::uuid
		)
		RETURNING `+metaColumns, scope.WorkspaceID(), meta.Type, meta.DisplayName, env.Ciphertext, env.DEKEnvelope,
		env.KeyRef, env.Version, md, tags, fp, meta.ExpiresAt, actorArg(scope)))
	if err != nil {
		return Metadata{}, err
	}
	if scope.ActorID() != "" && authz.ValidUUID(scope.ActorID()) {
		if _, err := tx.Exec(ctx, `
			INSERT INTO credential_permissions (workspace_id, credential_id, principal_type, principal_id, permission, granted_by)
			VALUES
				($1::uuid, $2::uuid, 'user', $3::uuid, 'manage', $3::uuid),
				($1::uuid, $2::uuid, 'user', $3::uuid, 'rotate', $3::uuid),
				($1::uuid, $2::uuid, 'user', $3::uuid, 'use', $3::uuid)
		`, scope.WorkspaceID(), out.ID, scope.ActorID()); err != nil {
			return Metadata{}, mapDBErr(err)
		}
	}
	if err := insertEvent(ctx, tx, scope, out.ID, EventCreated, map[string]any{"type": out.Type, "fingerprint": out.Fingerprint}); err != nil {
		return Metadata{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metadata{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) List(ctx context.Context, scope isolation.Scope) ([]Metadata, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT `+metaColumns+` FROM credentials ORDER BY updated_at DESC, display_name`)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Metadata
	for rows.Next() {
		meta, err := scanMeta(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, meta)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Metadata{}
	}
	return out, nil
}

func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, id string) (Metadata, error) {
	if scope.Zero() {
		return Metadata{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Metadata{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Metadata{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	meta, err := scanMeta(tx.QueryRow(ctx, `SELECT `+metaColumns+` FROM credentials WHERE id = $1::uuid`, id))
	if err != nil {
		return Metadata{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metadata{}, mapDBErr(err)
	}
	return meta, nil
}

func (p *Postgres) Update(ctx context.Context, scope isolation.Scope, id string, in UpdateInput) (Metadata, error) {
	current, err := p.Get(ctx, scope, id)
	if err != nil {
		return Metadata{}, err
	}
	if in.DisplayName != nil {
		name, err := normalizeDisplayName(*in.DisplayName)
		if err != nil {
			return Metadata{}, err
		}
		current.DisplayName = name
	}
	if in.Tags != nil {
		tags, err := sanitizeTags(*in.Tags)
		if err != nil {
			return Metadata{}, err
		}
		current.Tags = tags
	}
	if in.Metadata != nil {
		md, err := sanitizeMetadata(*in.Metadata)
		if err != nil {
			return Metadata{}, err
		}
		current.Metadata = md
	}
	if in.ExpiresAt != nil {
		exp, err := parseExpires(*in.ExpiresAt)
		if err != nil {
			return Metadata{}, err
		}
		current.ExpiresAt = exp
	}
	tags, err := json.Marshal(current.Tags)
	if err != nil {
		return Metadata{}, ErrInvalid
	}
	md, err := json.Marshal(current.Metadata)
	if err != nil {
		return Metadata{}, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Metadata{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	out, err := scanMeta(tx.QueryRow(ctx, `
		UPDATE credentials
		SET display_name = $2, tags = $3::jsonb, metadata = $4::jsonb, expires_at = $5,
		    updated_by = $6::uuid, updated_at = now()
		WHERE id = $1::uuid
		RETURNING `+metaColumns, id, current.DisplayName, tags, md, current.ExpiresAt, actorArg(scope)))
	if err != nil {
		return Metadata{}, err
	}
	if err := insertEvent(ctx, tx, scope, id, EventMetadataUpdated, map[string]any{"displayName": out.DisplayName}); err != nil {
		return Metadata{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metadata{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Rotate(ctx context.Context, scope isolation.Scope, id string, in RotateInput) (Metadata, error) {
	current, err := p.Get(ctx, scope, id)
	if err != nil {
		return Metadata{}, err
	}
	plain, fp, err := canonicalizeSecret(current.Type, in.Secret)
	if err != nil {
		return Metadata{}, err
	}
	env, err := Encrypt(p.keys, plain)
	if err != nil {
		return Metadata{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Metadata{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	out, err := scanMeta(tx.QueryRow(ctx, `
		UPDATE credentials
		SET ciphertext = $2, dek_envelope = $3, key_reference = $4, encryption_version = $5,
		    fingerprint = $6, rotated_at = now(), last_test_status = 'untested',
		    last_tested_at = NULL, last_test_reason = '',
		    updated_by = $7::uuid, updated_at = now()
		WHERE id = $1::uuid
		RETURNING `+metaColumns, id, env.Ciphertext, env.DEKEnvelope, env.KeyRef, env.Version, fp, actorArg(scope)))
	if err != nil {
		return Metadata{}, err
	}
	if err := insertEvent(ctx, tx, scope, id, EventRotated, map[string]any{"fingerprint": fp}); err != nil {
		return Metadata{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metadata{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Disable(ctx context.Context, scope isolation.Scope, id string) (Metadata, error) {
	return p.setStatus(ctx, scope, id, StatusDisabled, EventDisabled)
}

func (p *Postgres) Enable(ctx context.Context, scope isolation.Scope, id string) (Metadata, error) {
	return p.setStatus(ctx, scope, id, StatusActive, EventEnabled)
}

func (p *Postgres) setStatus(ctx context.Context, scope isolation.Scope, id, status, event string) (Metadata, error) {
	if scope.Zero() {
		return Metadata{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Metadata{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Metadata{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var disabled any
	if status == StatusDisabled {
		disabled = p.now()
	}
	out, err := scanMeta(tx.QueryRow(ctx, `
		UPDATE credentials
		SET status = $2, disabled_at = $3, updated_by = $4::uuid, updated_at = now()
		WHERE id = $1::uuid
		RETURNING `+metaColumns, id, status, disabled, actorArg(scope)))
	if err != nil {
		return Metadata{}, err
	}
	if err := insertEvent(ctx, tx, scope, id, event, map[string]any{"status": status}); err != nil {
		return Metadata{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Metadata{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Test(ctx context.Context, scope isolation.Scope, id string) (TestResult, Metadata, error) {
	plain, meta, err := p.unlockRow(ctx, scope, id, false)
	checked := p.now()
	if err != nil && (errors.Is(err, ErrNotFound) || errors.Is(err, ErrNoScope)) {
		return TestResult{}, Metadata{}, err
	}
	status, reason := TestFailed, safeUnlockReason(err)
	if err == nil {
		status, reason = TestPayload(meta.Type, plain)
	}
	tx, txErr := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if txErr != nil {
		return TestResult{}, Metadata{}, mapDBErr(txErr)
	}
	defer tx.Rollback(ctx)
	out, scanErr := scanMeta(tx.QueryRow(ctx, `
		UPDATE credentials
		SET last_test_status = $2, last_tested_at = $3, last_test_reason = $4, updated_at = $3
		WHERE id = $1::uuid
		RETURNING `+metaColumns, id, status, checked, reason))
	if scanErr != nil {
		return TestResult{}, Metadata{}, scanErr
	}
	if err := insertEvent(ctx, tx, scope, id, EventTested, map[string]any{"status": status, "reason": reason}); err != nil {
		return TestResult{}, Metadata{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TestResult{}, Metadata{}, mapDBErr(err)
	}
	return TestResult{Status: status, Reason: reason, CheckedAt: checked}, out, nil
}

func (p *Postgres) Use(ctx context.Context, scope isolation.Scope, id string) error {
	if _, _, err := p.unlockRow(ctx, scope, id, true); err != nil {
		return err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `
		UPDATE credentials
		SET last_used_at = now(), last_used_by = $2::uuid, use_count = use_count + 1
		WHERE id = $1::uuid
	`, id, actorArg(scope))
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := insertEvent(ctx, tx, scope, id, EventUsed, map[string]any{"outcome": "authorized"}); err != nil {
		return err
	}
	return mapDBErr(tx.Commit(ctx))
}

func (p *Postgres) Usage(ctx context.Context, scope isolation.Scope, id string) (Usage, error) {
	meta, err := p.Get(ctx, scope, id)
	if err != nil {
		return Usage{}, err
	}
	drafts, versions, execs, triggers := p.splitRefs(ctx, scope, id)
	return Usage{
		CredentialID: meta.ID,
		LastUsedAt:   meta.LastUsedAt,
		LastUsedBy:   meta.LastUsedBy,
		UseCount:     meta.UseCount,
		Drafts:       drafts,
		Versions:     versions,
		Executions:   execs,
		Triggers:     triggers,
	}, nil
}

func (p *Postgres) DeletionImpact(ctx context.Context, scope isolation.Scope, id string) (DeletionImpact, error) {
	meta, err := p.Get(ctx, scope, id)
	if err != nil {
		return DeletionImpact{}, err
	}
	drafts, versions, execs, triggers := p.splitRefs(ctx, scope, id)
	impact := DeletionImpact{
		CredentialID:     meta.ID,
		DisplayName:      meta.DisplayName,
		Status:           meta.Status,
		CanDelete:        len(execs) == 0 && len(triggers) == 0,
		Drafts:           drafts,
		Versions:         versions,
		ActiveExecutions: execs,
		Triggers:         triggers,
	}
	if len(execs) > 0 {
		impact.BlockReason = "An active execution references this credential."
	} else if len(triggers) > 0 {
		impact.BlockReason = "A webhook trigger references this credential."
	}
	return impact, nil
}

func (p *Postgres) Delete(ctx context.Context, scope isolation.Scope, id string, in DeleteInput) error {
	if !in.Confirm {
		return ErrNotConfirmed
	}
	impact, err := p.DeletionImpact(ctx, scope, id)
	if err != nil {
		return err
	}
	if !impact.CanDelete {
		return ErrInUse
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := insertEvent(ctx, tx, scope, id, EventDeleted, map[string]any{"displayName": impact.DisplayName}); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM credentials WHERE id = $1::uuid`, id)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return mapDBErr(tx.Commit(ctx))
}

func (p *Postgres) Events(ctx context.Context, scope isolation.Scope, id string) ([]Event, error) {
	if _, err := p.Get(ctx, scope, id); err != nil {
		return nil, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT id::text, credential_id::text, event_type, COALESCE(actor_id::text, ''), details_redacted, occurred_at
		FROM credential_events
		WHERE credential_id = $1::uuid
		ORDER BY occurred_at DESC
	`, id)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var evt Event
		var raw []byte
		if err := rows.Scan(&evt.ID, &evt.CredentialID, &evt.EventType, &evt.ActorID, &raw, &evt.OccurredAt); err != nil {
			return nil, mapDBErr(err)
		}
		if err := json.Unmarshal(raw, &evt.Details); err != nil || evt.Details == nil {
			evt.Details = map[string]any{}
		}
		out = append(out, evt)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Event{}
	}
	return out, nil
}

func (p *Postgres) Unlock(ctx context.Context, scope isolation.Scope, id string) ([]byte, error) {
	plain, _, err := p.unlockRow(ctx, scope, id, true)
	return plain, err
}

func (p *Postgres) unlockRow(ctx context.Context, scope isolation.Scope, id string, enforceActive bool) ([]byte, Metadata, error) {
	if scope.Zero() {
		return nil, Metadata{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return nil, Metadata{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, Metadata{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	meta, ciphertext, dek, err := scanStored(tx.QueryRow(ctx, `
		SELECT `+metaColumns+`, ciphertext, dek_envelope
		FROM credentials WHERE id = $1::uuid
	`, id))
	if err != nil {
		return nil, Metadata{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, Metadata{}, mapDBErr(err)
	}
	if enforceActive {
		if meta.Status != StatusActive {
			return nil, meta, ErrDisabled
		}
		if expired(meta.ExpiresAt, p.now()) {
			return nil, meta, ErrExpired
		}
	}
	plain, err := Decrypt(p.keys, Envelope{
		Ciphertext:  ciphertext,
		DEKEnvelope: dek,
		KeyRef:      meta.KeyReference,
		Version:     meta.EncryptionVersion,
	})
	if err != nil {
		return nil, meta, err
	}
	return plain, meta, nil
}

func (p *Postgres) splitRefs(ctx context.Context, scope isolation.Scope, id string) (drafts, versions, execs, triggers []wfstore.CredentialRef) {
	drafts, versions, execs, triggers = []wfstore.CredentialRef{}, []wfstore.CredentialRef{}, []wfstore.CredentialRef{}, []wfstore.CredentialRef{}
	if p.refs == nil {
		return drafts, versions, execs, triggers
	}
	found, err := p.refs.FindCredentialRefs(ctx, scope, id)
	if err != nil {
		return drafts, versions, execs, triggers
	}
	for _, ref := range found {
		switch ref.Kind {
		case wfstore.CredentialRefDraft:
			drafts = append(drafts, ref)
		case wfstore.CredentialRefVersion:
			versions = append(versions, ref)
		case wfstore.CredentialRefExecution:
			execs = append(execs, ref)
		case wfstore.CredentialRefTrigger:
			triggers = append(triggers, ref)
		}
	}
	return drafts, versions, execs, triggers
}

const metaColumns = `
id::text, type, display_name, status, tags, metadata, fingerprint, encryption_version, key_reference,
last_test_status, last_tested_at, last_test_reason, last_used_at, COALESCE(last_used_by::text, ''),
use_count, rotated_at, expires_at, disabled_at, COALESCE(created_by::text, ''), COALESCE(updated_by::text, ''),
created_at, updated_at
`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanMeta(row rowScanner) (Metadata, error) {
	meta, err := scanMetaFields(row, nil, nil)
	return meta, err
}

func scanStored(row rowScanner) (Metadata, []byte, []byte, error) {
	var ct, dek []byte
	meta, err := scanMetaFields(row, &ct, &dek)
	return meta, ct, dek, err
}

func scanMetaFields(row rowScanner, ct, dek *[]byte) (Metadata, error) {
	var (
		meta      Metadata
		tagsRaw   []byte
		metaRaw   []byte
		testedAt  *time.Time
		usedAt    *time.Time
		rotatedAt *time.Time
		expiresAt *time.Time
		disabled  *time.Time
	)
	dest := []any{
		&meta.ID, &meta.Type, &meta.DisplayName, &meta.Status, &tagsRaw, &metaRaw, &meta.Fingerprint,
		&meta.EncryptionVersion, &meta.KeyReference, &meta.LastTestStatus, &testedAt, &meta.LastTestReason,
		&usedAt, &meta.LastUsedBy, &meta.UseCount, &rotatedAt, &expiresAt, &disabled,
		&meta.CreatedBy, &meta.UpdatedBy, &meta.CreatedAt, &meta.UpdatedAt,
	}
	if ct != nil && dek != nil {
		dest = append(dest, ct, dek)
	}
	if err := row.Scan(dest...); err != nil {
		return Metadata{}, mapDBErr(err)
	}
	if err := json.Unmarshal(tagsRaw, &meta.Tags); err != nil || meta.Tags == nil {
		meta.Tags = []string{}
	}
	if err := json.Unmarshal(metaRaw, &meta.Metadata); err != nil || meta.Metadata == nil {
		meta.Metadata = map[string]string{}
	}
	meta.LastTestedAt = testedAt
	meta.LastUsedAt = usedAt
	meta.RotatedAt = rotatedAt
	meta.ExpiresAt = expiresAt
	meta.DisabledAt = disabled
	return meta, nil
}

func insertEvent(ctx context.Context, tx pgx.Tx, scope isolation.Scope, credentialID, eventType string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return ErrInvalid
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO credential_events (workspace_id, credential_id, event_type, actor_id, details_redacted)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb)
	`, scope.WorkspaceID(), credentialID, eventType, actorArg(scope), raw)
	return mapDBErr(err)
}

func actorArg(scope isolation.Scope) any {
	if scope.ActorID() == "" || !authz.ValidUUID(scope.ActorID()) {
		return nil
	}
	return scope.ActorID()
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
			return ErrConflict
		}
	}
	return err
}
