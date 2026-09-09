package opsconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

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

// Postgres persists ops-config under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

const resourceColumns = `
	r.id::text, r.kind, r.slug, r.name, r.status, r.draft_revision,
	COALESCE(r.credential_id::text, ''), COALESCE(r.policy_resource_id::text, ''),
	COALESCE(r.created_by::text, ''), COALESCE(r.updated_by::text, ''),
	r.created_at, r.updated_at,
	COALESCE(d.digest, ''),
	COALESCE((SELECT MAX(v.version_number) FROM ops_resource_versions v WHERE v.resource_id = r.id), 0),
	COALESCE((SELECT v.id::text FROM ops_resource_versions v WHERE v.resource_id = r.id ORDER BY v.version_number DESC LIMIT 1), ''),
	COALESCE((SELECT v.digest FROM ops_resource_versions v WHERE v.resource_id = r.id ORDER BY v.version_number DESC LIMIT 1), '')
`

func (p *Postgres) Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Resource, Draft, error) {
	if scope.Zero() {
		return Resource{}, Draft{}, ErrNoScope
	}
	if !ValidKind(in.Kind) {
		return Resource{}, Draft{}, fmt.Errorf("%w: unknown kind", ErrInvalid)
	}
	name, err := normalizeName(in.Name)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	slug, err := normalizeSlug(in.Slug, name)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	spec, digest, err := NormalizeSpec(in.Kind, in.Spec)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	payload, err := json.Marshal(spec)
	if err != nil {
		return Resource{}, Draft{}, ErrInvalid
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Resource{}, Draft{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var rec Resource
	err = tx.QueryRow(ctx, `
		INSERT INTO ops_resources (
			workspace_id, kind, slug, name, status, draft_revision,
			credential_id, policy_resource_id, created_by, updated_by
		) VALUES (
			$1::uuid, $2, $3, $4, 'draft', 1, $5::uuid, $6::uuid, $7::uuid, $7::uuid
		)
		RETURNING id::text, kind, slug, name, status, draft_revision,
		          COALESCE(credential_id::text, ''), COALESCE(policy_resource_id::text, ''),
		          COALESCE(created_by::text, ''), COALESCE(updated_by::text, ''), created_at, updated_at
	`, scope.WorkspaceID(), in.Kind, slug, name, nullUUID(credentialIDFromSpec(spec)),
		nullUUID(policyIDFromSpec(spec)), actorArg(scope)).Scan(
		&rec.ID, &rec.Kind, &rec.Slug, &rec.Name, &rec.Status, &rec.DraftRevision,
		&rec.CredentialID, &rec.PolicyID, &rec.CreatedBy, &rec.UpdatedBy, &rec.CreatedAt, &rec.UpdatedAt,
	)
	if err != nil {
		return Resource{}, Draft{}, mapDBErr(err)
	}

	draft, err := scanDraft(tx.QueryRow(ctx, `
		INSERT INTO ops_resource_drafts (workspace_id, resource_id, payload, digest, revision, updated_by)
		VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, 1, $5::uuid)
		RETURNING resource_id::text, revision, payload, digest, COALESCE(updated_by::text, ''), updated_at
	`, scope.WorkspaceID(), rec.ID, payload, digest, actorArg(scope)), in.Kind)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	rec.DraftDigest = draft.Digest
	if err := tx.Commit(ctx); err != nil {
		return Resource{}, Draft{}, mapDBErr(err)
	}
	return rec, draft, nil
}

func (p *Postgres) List(ctx context.Context, scope isolation.Scope, kind string) ([]Resource, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if kind != "" && !ValidKind(kind) {
		return nil, fmt.Errorf("%w: unknown kind", ErrInvalid)
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	q := `SELECT ` + resourceColumns + ` FROM ops_resources r
		LEFT JOIN ops_resource_drafts d ON d.resource_id = r.id
		WHERE ($1 = '' OR r.kind = $1)
		ORDER BY r.updated_at DESC, r.name`
	rows, err := tx.Query(ctx, q, kind)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Resource
	for rows.Next() {
		rec, err := scanResource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Resource{}
	}
	return out, nil
}

func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, kind, id string) (Resource, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return Resource{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Resource{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rec, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+`
		FROM ops_resources r
		LEFT JOIN ops_resource_drafts d ON d.resource_id = r.id
		WHERE r.id = $1::uuid AND r.kind = $2`, id, kind))
	if err != nil {
		return Resource{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Resource{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) GetDraft(ctx context.Context, scope isolation.Scope, kind, id string) (Draft, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return Draft{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Draft{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := assertKind(ctx, tx, kind, id); err != nil {
		return Draft{}, err
	}
	draft, err := scanDraft(tx.QueryRow(ctx, `
		SELECT resource_id::text, revision, payload, digest, COALESCE(updated_by::text, ''), updated_at
		FROM ops_resource_drafts WHERE resource_id = $1::uuid
	`, id), kind)
	if err != nil {
		return Draft{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Draft{}, mapDBErr(err)
	}
	return draft, nil
}

func (p *Postgres) SaveDraft(ctx context.Context, scope isolation.Scope, kind, id string, in SaveInput) (Resource, Draft, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return Resource{}, Draft{}, err
	}
	if in.ExpectedRevision < 1 {
		return Resource{}, Draft{}, fmt.Errorf("%w: revision is required", ErrInvalid)
	}
	spec, digest, err := NormalizeSpec(kind, in.Spec)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	payload, err := json.Marshal(spec)
	if err != nil {
		return Resource{}, Draft{}, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Resource{}, Draft{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := assertKind(ctx, tx, kind, id); err != nil {
		return Resource{}, Draft{}, err
	}
	draft, err := scanDraft(tx.QueryRow(ctx, `
		UPDATE ops_resource_drafts
		SET payload = $2::jsonb, digest = $3, revision = revision + 1, updated_by = $4::uuid, updated_at = now()
		WHERE resource_id = $1::uuid AND revision = $5
		RETURNING resource_id::text, revision, payload, digest, COALESCE(updated_by::text, ''), updated_at
	`, id, payload, digest, actorArg(scope), in.ExpectedRevision), kind)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Resource{}, Draft{}, ErrRevisionConflict
		}
		return Resource{}, Draft{}, err
	}
	name := strings.TrimSpace(in.Name)
	_, err = tx.Exec(ctx, `
		UPDATE ops_resources
		SET name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
		    draft_revision = $3,
		    credential_id = $4::uuid,
		    policy_resource_id = $5::uuid,
		    updated_by = $6::uuid,
		    updated_at = now()
		WHERE id = $1::uuid
	`, id, name, draft.Revision, nullUUID(credentialIDFromSpec(spec)), nullUUID(policyIDFromSpec(spec)), actorArg(scope))
	if err != nil {
		return Resource{}, Draft{}, mapDBErr(err)
	}
	rec, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+`
		FROM ops_resources r LEFT JOIN ops_resource_drafts d ON d.resource_id = r.id
		WHERE r.id = $1::uuid`, id))
	if err != nil {
		return Resource{}, Draft{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Resource{}, Draft{}, mapDBErr(err)
	}
	return rec, draft, nil
}

func (p *Postgres) Publish(ctx context.Context, scope isolation.Scope, kind, id string, in PublishInput) (Resource, Version, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return Resource{}, Version{}, err
	}
	if strings.TrimSpace(in.Note) != in.Note || len(in.Note) > 2000 {
		return Resource{}, Version{}, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Resource{}, Version{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM ops_resources WHERE id = $1::uuid AND kind = $2 FOR UPDATE`, id, kind).Scan(&status); err != nil {
		return Resource{}, Version{}, mapDBErr(err)
	}
	if status == StatusDisabled {
		return Resource{}, Version{}, ErrDisabled
	}
	draft, err := scanDraft(tx.QueryRow(ctx, `
		SELECT resource_id::text, revision, payload, digest, COALESCE(updated_by::text, ''), updated_at
		FROM ops_resource_drafts WHERE resource_id = $1::uuid FOR UPDATE
	`, id), kind)
	if err != nil {
		return Resource{}, Version{}, err
	}
	if in.ExpectedRevision > 0 && draft.Revision != in.ExpectedRevision {
		return Resource{}, Version{}, ErrRevisionConflict
	}
	payload, err := json.Marshal(draft.Spec)
	if err != nil {
		return Resource{}, Version{}, ErrInvalid
	}
	var next int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(version_number), 0) + 1 FROM ops_resource_versions WHERE resource_id = $1::uuid`, id).Scan(&next); err != nil {
		return Resource{}, Version{}, mapDBErr(err)
	}
	ver, err := scanVersion(tx.QueryRow(ctx, `
		INSERT INTO ops_resource_versions (
			workspace_id, resource_id, version_number, payload, digest, publish_note, published_by
		) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7::uuid)
		RETURNING id::text, resource_id::text, version_number, payload, digest, publish_note,
		          COALESCE(published_by::text, ''), published_at
	`, scope.WorkspaceID(), id, next, payload, draft.Digest, in.Note, actorArg(scope)), kind)
	if err != nil {
		return Resource{}, Version{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ops_resources
		SET status = 'published', updated_by = $2::uuid, updated_at = now()
		WHERE id = $1::uuid
	`, id, actorArg(scope)); err != nil {
		return Resource{}, Version{}, mapDBErr(err)
	}
	if err := bindPolicy(ctx, tx, scope, kind, id, draft.Spec, ver.ID); err != nil {
		return Resource{}, Version{}, err
	}
	rec, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+`
		FROM ops_resources r LEFT JOIN ops_resource_drafts d ON d.resource_id = r.id
		WHERE r.id = $1::uuid`, id))
	if err != nil {
		return Resource{}, Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Resource{}, Version{}, mapDBErr(err)
	}
	return rec, ver, nil
}

func (p *Postgres) ListVersions(ctx context.Context, scope isolation.Scope, kind, id string) ([]Version, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return nil, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := assertKind(ctx, tx, kind, id); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, resource_id::text, version_number, payload, digest, publish_note,
		       COALESCE(published_by::text, ''), published_at
		FROM ops_resource_versions WHERE resource_id = $1::uuid
		ORDER BY version_number DESC
	`, id)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Version
	for rows.Next() {
		ver, err := scanVersion(rows, kind)
		if err != nil {
			return nil, err
		}
		out = append(out, ver)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Version{}
	}
	return out, nil
}

func (p *Postgres) GetVersion(ctx context.Context, scope isolation.Scope, kind, id, versionID string) (Version, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return Version{}, err
	}
	if !authz.ValidUUID(versionID) {
		return Version{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Version{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := assertKind(ctx, tx, kind, id); err != nil {
		return Version{}, err
	}
	ver, err := scanVersion(tx.QueryRow(ctx, `
		SELECT id::text, resource_id::text, version_number, payload, digest, publish_note,
		       COALESCE(published_by::text, ''), published_at
		FROM ops_resource_versions WHERE resource_id = $1::uuid AND id = $2::uuid
	`, id, versionID), kind)
	if err != nil {
		return Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Version{}, mapDBErr(err)
	}
	return ver, nil
}

func (p *Postgres) Disable(ctx context.Context, scope isolation.Scope, kind, id string) (Resource, error) {
	return p.setStatus(ctx, scope, kind, id, StatusDisabled)
}

func (p *Postgres) Enable(ctx context.Context, scope isolation.Scope, kind, id string) (Resource, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return Resource{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Resource{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var n int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM ops_resource_versions WHERE resource_id = $1::uuid`, id).Scan(&n); err != nil {
		return Resource{}, mapDBErr(err)
	}
	status := StatusDraft
	if n > 0 {
		status = StatusPublished
	}
	if _, err := tx.Exec(ctx, `UPDATE ops_resources SET status = $2, updated_by = $3::uuid, updated_at = now() WHERE id = $1::uuid AND kind = $4`, id, status, actorArg(scope), kind); err != nil {
		return Resource{}, mapDBErr(err)
	}
	rec, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+`
		FROM ops_resources r LEFT JOIN ops_resource_drafts d ON d.resource_id = r.id
		WHERE r.id = $1::uuid`, id))
	if err != nil {
		return Resource{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Resource{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) setStatus(ctx context.Context, scope isolation.Scope, kind, id, status string) (Resource, error) {
	if err := requireRef(scope, kind, id); err != nil {
		return Resource{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Resource{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE ops_resources SET status = $2, updated_by = $3::uuid, updated_at = now() WHERE id = $1::uuid AND kind = $4`, id, status, actorArg(scope), kind)
	if err != nil {
		return Resource{}, mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return Resource{}, ErrNotFound
	}
	rec, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+`
		FROM ops_resources r LEFT JOIN ops_resource_drafts d ON d.resource_id = r.id
		WHERE r.id = $1::uuid`, id))
	if err != nil {
		return Resource{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Resource{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) Select(ctx context.Context, scope isolation.Scope, kind, id string, in SelectInput) (Pin, error) {
	pins, err := p.Resolve(ctx, scope, []Ref{{Kind: kind, ResourceID: id, VersionID: in.VersionID}})
	if err != nil {
		return Pin{}, err
	}
	if len(pins) != 1 {
		return Pin{}, ErrNotFound
	}
	return pins[0], nil
}

func (p *Postgres) Resolve(ctx context.Context, scope isolation.Scope, refs []Ref) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var out []Pin
	for _, ref := range refs {
		pin, err := resolveOne(ctx, tx, ref)
		if err != nil {
			return nil, err
		}
		out = append(out, pin)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Pin{}
	}
	return out, nil
}

func (p *Postgres) BindPins(ctx context.Context, scope isolation.Scope, in BindInput) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if in.OwnerKind != OwnerWorkflowVersion && in.OwnerKind != OwnerExecution {
		return nil, fmt.Errorf("%w: owner kind", ErrInvalid)
	}
	if !authz.ValidUUID(in.OwnerID) {
		return nil, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var existing int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM ops_pins WHERE owner_kind = $1 AND owner_id = $2::uuid`, in.OwnerKind, in.OwnerID).Scan(&existing); err != nil {
		return nil, mapDBErr(err)
	}
	if existing > 0 {
		return nil, ErrImmutable
	}
	for _, pin := range in.Pins {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ops_pins (
				workspace_id, owner_kind, owner_id, resource_kind, resource_id,
				version_id, version_number, digest
			) VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8)
		`, scope.WorkspaceID(), in.OwnerKind, in.OwnerID, pin.Kind, pin.ResourceID, pin.VersionID, pin.VersionNumber, pin.Digest); err != nil {
			return nil, mapDBErr(err)
		}
	}
	out, err := listPinsTx(ctx, tx, in.OwnerKind, in.OwnerID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) ListPins(ctx context.Context, scope isolation.Scope, ownerKind, ownerID string) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	out, err := listPinsTx(ctx, tx, ownerKind, ownerID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) CopyPins(ctx context.Context, scope isolation.Scope, fromKind, fromID, toKind, toID string) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var existing int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM ops_pins WHERE owner_kind = $1 AND owner_id = $2::uuid`, toKind, toID).Scan(&existing); err != nil {
		return nil, mapDBErr(err)
	}
	if existing == 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ops_pins (
				workspace_id, owner_kind, owner_id, resource_kind, resource_id,
				version_id, version_number, digest
			)
			SELECT workspace_id, $3, $4::uuid, resource_kind, resource_id, version_id, version_number, digest
			FROM ops_pins WHERE owner_kind = $1 AND owner_id = $2::uuid
		`, fromKind, fromID, toKind, toID); err != nil {
			return nil, mapDBErr(err)
		}
	}
	out, err := listPinsTx(ctx, tx, toKind, toID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]wfstore.CredentialRef, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(credentialID) {
		return []wfstore.CredentialRef{}, nil
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT r.id::text, r.slug, r.name,
		       COALESCE(v.id::text, ''), COALESCE(v.version_number, 0),
		       COALESCE(p.owner_id::text, ''), COALESCE(p.owner_kind, '')
		FROM ops_resources r
		LEFT JOIN ops_resource_versions v ON v.resource_id = r.id
		LEFT JOIN ops_pins p ON p.resource_id = r.id
		WHERE r.credential_id = $1::uuid
		ORDER BY r.updated_at DESC
	`, credentialID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []wfstore.CredentialRef
	seen := map[string]struct{}{}
	add := func(ref wfstore.CredentialRef) {
		key := ref.Kind + "\x00" + ref.WorkflowID + "\x00" + ref.VersionID + "\x00" + ref.ExecutionID
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, ref)
	}
	for rows.Next() {
		var id, slug, name, versionID, ownerID, ownerKind string
		var versionNumber int
		if err := rows.Scan(&id, &slug, &name, &versionID, &versionNumber, &ownerID, &ownerKind); err != nil {
			return nil, mapDBErr(err)
		}
		add(wfstore.CredentialRef{Kind: wfstore.CredentialRefDraft, WorkflowID: id, WorkflowSlug: slug, WorkflowName: name})
		if versionID != "" {
			add(wfstore.CredentialRef{Kind: wfstore.CredentialRefVersion, WorkflowID: id, WorkflowSlug: slug, WorkflowName: name, VersionID: versionID, VersionNumber: versionNumber})
		}
		if ownerKind == OwnerExecution && ownerID != "" {
			add(wfstore.CredentialRef{Kind: wfstore.CredentialRefExecution, WorkflowID: id, WorkflowSlug: slug, WorkflowName: name, VersionID: versionID, VersionNumber: versionNumber, ExecutionID: ownerID, ExecutionStatus: wfstore.ExecutionPinned})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []wfstore.CredentialRef{}
	}
	return out, nil
}

func resolveOne(ctx context.Context, tx pgx.Tx, ref Ref) (Pin, error) {
	if !ValidKind(ref.Kind) || !authz.ValidUUID(ref.ResourceID) {
		return Pin{}, ErrNotFound
	}
	var status, name, slug string
	err := tx.QueryRow(ctx, `SELECT status, name, slug FROM ops_resources WHERE id = $1::uuid AND kind = $2`, ref.ResourceID, ref.Kind).Scan(&status, &name, &slug)
	if err != nil {
		return Pin{}, mapDBErr(err)
	}
	if status == StatusDisabled {
		return Pin{}, ErrDisabled
	}
	if status == StatusDraft {
		return Pin{}, ErrDraftNotUsable
	}
	var ver Version
	if strings.TrimSpace(ref.VersionID) == "" {
		ver, err = scanVersion(tx.QueryRow(ctx, `
			SELECT id::text, resource_id::text, version_number, payload, digest, publish_note,
			       COALESCE(published_by::text, ''), published_at
			FROM ops_resource_versions WHERE resource_id = $1::uuid
			ORDER BY version_number DESC LIMIT 1
		`, ref.ResourceID), ref.Kind)
	} else {
		if !authz.ValidUUID(ref.VersionID) {
			return Pin{}, ErrNotFound
		}
		ver, err = scanVersion(tx.QueryRow(ctx, `
			SELECT id::text, resource_id::text, version_number, payload, digest, publish_note,
			       COALESCE(published_by::text, ''), published_at
			FROM ops_resource_versions WHERE resource_id = $1::uuid AND id = $2::uuid
		`, ref.ResourceID, ref.VersionID), ref.Kind)
	}
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Pin{}, ErrDraftNotUsable
		}
		return Pin{}, err
	}
	return Pin{
		Kind:          ref.Kind,
		ResourceID:    ref.ResourceID,
		VersionID:     ver.ID,
		VersionNumber: ver.VersionNumber,
		Digest:        ver.Digest,
		Name:          name,
		Slug:          slug,
		Spec:          ver.Spec,
	}, nil
}

func listPinsTx(ctx context.Context, tx pgx.Tx, ownerKind, ownerID string) ([]Pin, error) {
	rows, err := tx.Query(ctx, `
		SELECT p.resource_kind, p.resource_id::text, p.version_id::text, p.version_number, p.digest,
		       r.name, r.slug, v.payload
		FROM ops_pins p
		JOIN ops_resources r ON r.id = p.resource_id
		JOIN ops_resource_versions v ON v.id = p.version_id
		WHERE p.owner_kind = $1 AND p.owner_id = $2::uuid
		ORDER BY p.resource_kind, r.name
	`, ownerKind, ownerID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Pin
	for rows.Next() {
		var pin Pin
		var raw []byte
		if err := rows.Scan(&pin.Kind, &pin.ResourceID, &pin.VersionID, &pin.VersionNumber, &pin.Digest, &pin.Name, &pin.Slug, &raw); err != nil {
			return nil, mapDBErr(err)
		}
		_ = json.Unmarshal(raw, &pin.Spec)
		if pin.Spec == nil {
			pin.Spec = map[string]any{}
		}
		out = append(out, pin)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Pin{}
	}
	return out, nil
}

func bindPolicy(ctx context.Context, tx pgx.Tx, scope isolation.Scope, kind, resourceID string, spec map[string]any, _ string) error {
	switch kind {
	case KindClusterTarget, KindSSHTarget, KindCommandProfile, KindConnection:
	default:
		return nil
	}
	policyID := policyIDFromSpec(spec)
	if policyID == "" {
		return nil
	}
	if !authz.ValidUUID(policyID) {
		return ErrInvalid
	}
	var policyKind, status string
	if err := tx.QueryRow(ctx, `SELECT kind, status FROM ops_resources WHERE id = $1::uuid`, policyID).Scan(&policyKind, &status); err != nil {
		return mapDBErr(err)
	}
	if policyKind != KindPolicy {
		return fmt.Errorf("%w: policyId must reference a policy", ErrInvalid)
	}
	if status == StatusDisabled {
		return ErrDisabled
	}
	var policyVersionID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM ops_resource_versions
		WHERE resource_id = $1::uuid ORDER BY version_number DESC LIMIT 1
	`, policyID).Scan(&policyVersionID); err != nil {
		return mapDBErr(err)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO target_policy_bindings (workspace_id, target_kind, target_id, policy_version_id)
		VALUES ($1::uuid, $2, $3::uuid, $4::uuid)
		ON CONFLICT (workspace_id, target_kind, target_id)
		DO UPDATE SET policy_version_id = EXCLUDED.policy_version_id, bound_at = now()
	`, scope.WorkspaceID(), kind, resourceID, policyVersionID)
	return mapDBErr(err)
}

func assertKind(ctx context.Context, tx pgx.Tx, kind, id string) error {
	var found string
	if err := tx.QueryRow(ctx, `SELECT kind FROM ops_resources WHERE id = $1::uuid`, id).Scan(&found); err != nil {
		return mapDBErr(err)
	}
	if found != kind {
		return ErrNotFound
	}
	return nil
}

func requireRef(scope isolation.Scope, kind, id string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if !ValidKind(kind) || !authz.ValidUUID(id) {
		return ErrNotFound
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanResource(row rowScanner) (Resource, error) {
	var rec Resource
	if err := row.Scan(
		&rec.ID, &rec.Kind, &rec.Slug, &rec.Name, &rec.Status, &rec.DraftRevision,
		&rec.CredentialID, &rec.PolicyID, &rec.CreatedBy, &rec.UpdatedBy, &rec.CreatedAt, &rec.UpdatedAt,
		&rec.DraftDigest, &rec.LatestVersionNumber, &rec.LatestVersionID, &rec.LatestVersionDigest,
	); err != nil {
		return Resource{}, mapDBErr(err)
	}
	return rec, nil
}

func scanDraft(row rowScanner, kind string) (Draft, error) {
	var d Draft
	var raw []byte
	if err := row.Scan(&d.ResourceID, &d.Revision, &raw, &d.Digest, &d.UpdatedBy, &d.UpdatedAt); err != nil {
		return Draft{}, mapDBErr(err)
	}
	d.Kind = kind
	if err := json.Unmarshal(raw, &d.Spec); err != nil || d.Spec == nil {
		d.Spec = map[string]any{}
	}
	return d, nil
}

func scanVersion(row rowScanner, kind string) (Version, error) {
	var v Version
	var raw []byte
	if err := row.Scan(&v.ID, &v.ResourceID, &v.VersionNumber, &raw, &v.Digest, &v.PublishNote, &v.PublishedBy, &v.PublishedAt); err != nil {
		return Version{}, mapDBErr(err)
	}
	v.Kind = kind
	if err := json.Unmarshal(raw, &v.Spec); err != nil || v.Spec == nil {
		v.Spec = map[string]any{}
	}
	return v, nil
}

func actorArg(scope isolation.Scope) any {
	if scope.ActorID() == "" || !authz.ValidUUID(scope.ActorID()) {
		return nil
	}
	return scope.ActorID()
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
			if strings.Contains(pgErr.ConstraintName, "digest") {
				return ErrConflict
			}
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
