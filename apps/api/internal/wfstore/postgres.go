package wfstore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
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

// Postgres persists workflows under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Workflow, Draft, error) {
	if scope.Zero() {
		return Workflow{}, Draft{}, ErrNoScope
	}
	if err := validateCreate(in); err != nil {
		return Workflow{}, Draft{}, err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = in.Summary.Name
	}
	slug := strings.TrimSpace(in.Slug)
	if slug == "" {
		slug = in.Summary.Name
	}
	parsed, err := json.Marshal(in.Summary)
	if err != nil {
		return Workflow{}, Draft{}, ErrInvalid
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var wf Workflow
	err = tx.QueryRow(ctx, `
		INSERT INTO workflows (workspace_id, slug, name, status, draft_revision, created_by, updated_by)
		VALUES ($1::uuid, $2, $3, 'draft', 1, $4::uuid, $4::uuid)
		RETURNING id::text, slug, name, status, draft_revision,
		          COALESCE(created_by::text, ''), COALESCE(updated_by::text, ''), created_at, updated_at
	`, scope.WorkspaceID(), slug, name, actorArg(scope)).Scan(
		&wf.ID, &wf.Slug, &wf.Name, &wf.Status, &wf.DraftRevision,
		&wf.CreatedBy, &wf.UpdatedBy, &wf.CreatedAt, &wf.UpdatedAt,
	)
	if err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}

	draft, err := insertDraft(ctx, tx, scope, wf.ID, 1, in.NormalizedYAML, in.Digest, parsed, in.Summary)
	if err != nil {
		return Workflow{}, Draft{}, err
	}
	wf.DraftDigest = draft.Digest
	if err := tx.Commit(ctx); err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	return wf, draft, nil
}

func (p *Postgres) List(ctx context.Context, scope isolation.Scope) ([]Workflow, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, listWorkflowSQL)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Workflow
	for rows.Next() {
		wf, err := scanWorkflow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, wf)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Workflow{}
	}
	return out, nil
}

func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, id string) (Workflow, error) {
	if scope.Zero() {
		return Workflow{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Workflow{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Workflow{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	wf, err := scanWorkflow(tx.QueryRow(ctx, getWorkflowSQL, id))
	if err != nil {
		return Workflow{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workflow{}, mapDBErr(err)
	}
	return wf, nil
}

func (p *Postgres) GetDraft(ctx context.Context, scope isolation.Scope, workflowID string) (Draft, error) {
	if scope.Zero() {
		return Draft{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) {
		return Draft{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Draft{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	draft, err := scanDraft(tx.QueryRow(ctx, getDraftSQL, workflowID))
	if err != nil {
		return Draft{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Draft{}, mapDBErr(err)
	}
	return draft, nil
}

func (p *Postgres) SaveDraft(ctx context.Context, scope isolation.Scope, workflowID string, in SaveInput) (Workflow, Draft, error) {
	if scope.Zero() {
		return Workflow{}, Draft{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) {
		return Workflow{}, Draft{}, ErrNotFound
	}
	if err := validateNormalized(in.NormalizedYAML, in.Digest, in.Summary); err != nil {
		return Workflow{}, Draft{}, err
	}
	if in.ExpectedRevision < 1 {
		return Workflow{}, Draft{}, ErrInvalid
	}
	parsed, err := json.Marshal(in.Summary)
	if err != nil {
		return Workflow{}, Draft{}, ErrInvalid
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var current int64
	err = tx.QueryRow(ctx, `SELECT revision FROM workflow_drafts WHERE workflow_id = $1::uuid`, workflowID).Scan(&current)
	if err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	if current != in.ExpectedRevision {
		return Workflow{}, Draft{}, ErrRevisionConflict
	}

	draft, err := scanDraft(tx.QueryRow(ctx, `
		UPDATE workflow_drafts
		SET normalized_yaml = $2,
		    definition_digest = $3,
		    parsed_definition = $4::jsonb,
		    validation_state = 'valid',
		    revision = revision + 1,
		    updated_by = $5::uuid,
		    updated_at = now()
		WHERE workflow_id = $1::uuid AND revision = $6
		RETURNING workflow_id::text, revision, normalized_yaml, definition_digest, parsed_definition,
		          validation_state, COALESCE(updated_by::text, ''), updated_at
	`, workflowID, in.NormalizedYAML, in.Digest, parsed, actorArg(scope), in.ExpectedRevision))
	if err != nil {
		return Workflow{}, Draft{}, err
	}

	name := firstNonEmpty(in.Summary.Name)
	_, err = tx.Exec(ctx, `
		UPDATE workflows
		SET name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
		    draft_revision = $3,
		    updated_by = $4::uuid,
		    updated_at = now()
		WHERE id = $1::uuid
	`, workflowID, name, draft.Revision, actorArg(scope))
	if err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}

	wf, err := scanWorkflow(tx.QueryRow(ctx, getWorkflowSQL, workflowID))
	if err != nil {
		return Workflow{}, Draft{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	return wf, draft, nil
}

func (p *Postgres) Publish(ctx context.Context, scope isolation.Scope, workflowID string, in PublishInput) (Workflow, Version, error) {
	if scope.Zero() {
		return Workflow{}, Version{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) {
		return Workflow{}, Version{}, ErrNotFound
	}
	if strings.TrimSpace(in.Note) != in.Note || len(in.Note) > 2000 {
		return Workflow{}, Version{}, ErrInvalid
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Workflow{}, Version{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	draft, err := scanDraft(tx.QueryRow(ctx, getDraftSQL+` FOR UPDATE`, workflowID))
	if err != nil {
		return Workflow{}, Version{}, err
	}
	if in.ExpectedRevision > 0 && draft.Revision != in.ExpectedRevision {
		return Workflow{}, Version{}, ErrRevisionConflict
	}

	var next int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(version_number), 0) + 1
		FROM workflow_versions WHERE workflow_id = $1::uuid
	`, workflowID).Scan(&next); err != nil {
		return Workflow{}, Version{}, mapDBErr(err)
	}

	parsed, err := json.Marshal(draft.Summary)
	if err != nil {
		return Workflow{}, Version{}, ErrInvalid
	}

	ver, err := scanVersion(tx.QueryRow(ctx, `
		INSERT INTO workflow_versions (
			workspace_id, workflow_id, version_number, normalized_yaml, definition_digest,
			parsed_definition, publish_note, published_by
		) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::uuid)
		RETURNING id::text, workflow_id::text, version_number, normalized_yaml, definition_digest,
		          parsed_definition, publish_note, COALESCE(published_by::text, ''), published_at
	`, scope.WorkspaceID(), workflowID, next, draft.DefinitionYAML, draft.Digest, parsed, in.Note, actorArg(scope)))
	if err != nil {
		return Workflow{}, Version{}, err
	}

	_, err = tx.Exec(ctx, `
		UPDATE workflows
		SET status = 'published', updated_by = $2::uuid, updated_at = now()
		WHERE id = $1::uuid
	`, workflowID, actorArg(scope))
	if err != nil {
		return Workflow{}, Version{}, mapDBErr(err)
	}

	wf, err := scanWorkflow(tx.QueryRow(ctx, getWorkflowSQL, workflowID))
	if err != nil {
		return Workflow{}, Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workflow{}, Version{}, mapDBErr(err)
	}
	return wf, ver, nil
}

func (p *Postgres) ListVersions(ctx context.Context, scope isolation.Scope, workflowID string) ([]Version, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) {
		return nil, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	if err := requireWorkflow(ctx, tx, workflowID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, workflow_id::text, version_number, normalized_yaml, definition_digest,
		       parsed_definition, publish_note, COALESCE(published_by::text, ''), published_at
		FROM workflow_versions
		WHERE workflow_id = $1::uuid
		ORDER BY version_number DESC
	`, workflowID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Version
	for rows.Next() {
		ver, err := scanVersion(rows)
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

func (p *Postgres) GetVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (Version, error) {
	if scope.Zero() {
		return Version{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) || !authz.ValidUUID(versionID) {
		return Version{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Version{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	ver, err := scanVersion(tx.QueryRow(ctx, getVersionSQL, workflowID, versionID))
	if err != nil {
		return Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Version{}, mapDBErr(err)
	}
	return ver, nil
}

func (p *Postgres) Compare(ctx context.Context, scope isolation.Scope, workflowID string, left, right CompareRef) (CompareResult, error) {
	if scope.Zero() {
		return CompareResult{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) {
		return CompareResult{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return CompareResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	if err := requireWorkflow(ctx, tx, workflowID); err != nil {
		return CompareResult{}, err
	}
	leftDoc, leftRef, err := resolveCompareTx(ctx, tx, workflowID, left)
	if err != nil {
		return CompareResult{}, err
	}
	rightDoc, rightRef, err := resolveCompareTx(ctx, tx, workflowID, right)
	if err != nil {
		return CompareResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CompareResult{}, mapDBErr(err)
	}
	return compareDefinitions(leftRef, rightRef, leftDoc.yaml, rightDoc.yaml, leftDoc.digest, rightDoc.digest, leftDoc.summary, rightDoc.summary), nil
}

func (p *Postgres) Restore(ctx context.Context, scope isolation.Scope, workflowID string, in RestoreInput) (Workflow, Draft, error) {
	if scope.Zero() {
		return Workflow{}, Draft{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) || !authz.ValidUUID(in.VersionID) {
		return Workflow{}, Draft{}, ErrNotFound
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	ver, err := scanVersion(tx.QueryRow(ctx, getVersionSQL, workflowID, in.VersionID))
	if err != nil {
		return Workflow{}, Draft{}, err
	}

	var current int64
	if err := tx.QueryRow(ctx, `SELECT revision FROM workflow_drafts WHERE workflow_id = $1::uuid FOR UPDATE`, workflowID).Scan(&current); err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	if in.ExpectedRevision > 0 && current != in.ExpectedRevision {
		return Workflow{}, Draft{}, ErrRevisionConflict
	}

	parsed, err := json.Marshal(ver.Summary)
	if err != nil {
		return Workflow{}, Draft{}, ErrInvalid
	}

	draft, err := scanDraft(tx.QueryRow(ctx, `
		UPDATE workflow_drafts
		SET normalized_yaml = $2,
		    definition_digest = $3,
		    parsed_definition = $4::jsonb,
		    validation_state = 'valid',
		    revision = revision + 1,
		    updated_by = $5::uuid,
		    updated_at = now()
		WHERE workflow_id = $1::uuid
		RETURNING workflow_id::text, revision, normalized_yaml, definition_digest, parsed_definition,
		          validation_state, COALESCE(updated_by::text, ''), updated_at
	`, workflowID, ver.DefinitionYAML, ver.Digest, parsed, actorArg(scope)))
	if err != nil {
		return Workflow{}, Draft{}, err
	}

	_, err = tx.Exec(ctx, `
		UPDATE workflows
		SET name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
		    draft_revision = $3,
		    updated_by = $4::uuid,
		    updated_at = now()
		WHERE id = $1::uuid
	`, workflowID, firstNonEmpty(ver.Summary.Name), draft.Revision, actorArg(scope))
	if err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}

	wf, err := scanWorkflow(tx.QueryRow(ctx, getWorkflowSQL, workflowID))
	if err != nil {
		return Workflow{}, Draft{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workflow{}, Draft{}, mapDBErr(err)
	}
	return wf, draft, nil
}

func (p *Postgres) StartExecution(ctx context.Context, scope isolation.Scope, workflowID string, in StartInput) (Execution, error) {
	prepared, err := prepareStart(scope, workflowID, in)
	if err != nil {
		return Execution{}, err
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Execution{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	ver, err := scanVersion(tx.QueryRow(ctx, getVersionSQL, workflowID, in.VersionID))
	if err != nil {
		return Execution{}, err
	}
	if prepared.policy["workflowVersionId"] == nil {
		prepared.policy["workflowVersionId"] = ver.ID
		prepared.policy["workflowDigest"] = ver.Digest
	}

	if prepared.key != "" {
		existing, found, ferr := lookupIdempotentTx(ctx, tx, workflowID, ver.ID, prepared.key)
		if ferr != nil {
			return Execution{}, ferr
		}
		if found {
			if existing.fingerprint != prepared.fingerprint {
				return Execution{}, ErrIdempotencyConflict
			}
			existing.Replayed = true
			if err := tx.Commit(ctx); err != nil {
				return Execution{}, mapDBErr(err)
			}
			return existing, nil
		}
	}

	inputRaw, err := marshalObject(prepared.input)
	if err != nil {
		return Execution{}, ErrInvalid
	}
	policyRaw, err := marshalObject(prepared.policy)
	if err != nil {
		return Execution{}, ErrInvalid
	}

	exec, err := scanExecution(tx.QueryRow(ctx, `
		INSERT INTO executions (
			workspace_id, workflow_id, workflow_version_id, workflow_digest, status,
			trigger_id, idempotency_key, idempotency_fingerprint, input_redacted, policy_snapshot,
			correlation_id, requested_by, started_at, retention_until
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4, 'queued',
			NULLIF($5, '')::uuid, NULLIF($6, ''), NULLIF($7, ''), $8::jsonb, $9::jsonb,
			NULLIF($10, ''), $11::uuid, now(), now() + interval '90 days'
		)
		RETURNING `+executionInsertReturning+`
	`, scope.WorkspaceID(), workflowID, ver.ID, ver.Digest, strings.TrimSpace(in.TriggerID),
		prepared.key, prepared.fingerprint, inputRaw, policyRaw, strings.TrimSpace(in.CorrelationID), actorArg(scope)))
	if err != nil {
		if errors.Is(err, ErrConflict) && prepared.key != "" {
			existing, found, ferr := lookupIdempotentTx(ctx, tx, workflowID, ver.ID, prepared.key)
			if ferr != nil {
				return Execution{}, ferr
			}
			if found && existing.fingerprint == prepared.fingerprint {
				existing.Replayed = true
				if err := tx.Commit(ctx); err != nil {
					return Execution{}, mapDBErr(err)
				}
				return existing, nil
			}
			return Execution{}, ErrIdempotencyConflict
		}
		return Execution{}, err
	}

	if err := insertPlanTx(ctx, tx, scope, exec.ID, planNodes(ver.DefinitionYAML, ver.Summary)); err != nil {
		return Execution{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:        "execution.start",
		ResourceType:  "execution",
		ResourceID:    exec.ID,
		Outcome:       "created",
		CorrelationID: exec.CorrelationID,
		HostContext:   in.HostContext,
		Details: map[string]any{
			"workflowId":        workflowID,
			"workflowVersionId": ver.ID,
		},
	}); err != nil {
		return Execution{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Execution{}, mapDBErr(err)
	}
	return exec, nil
}

func (p *Postgres) FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]CredentialRef, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(credentialID) {
		return []CredentialRef{}, nil
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT 'draft', w.id::text, w.slug, w.name, '', 0, '', ''
		FROM workflow_drafts d
		JOIN workflows w ON w.workspace_id = d.workspace_id AND w.id = d.workflow_id
		WHERE position($1 in d.normalized_yaml) > 0
		UNION ALL
		SELECT 'version', w.id::text, w.slug, w.name, v.id::text, v.version_number, '', ''
		FROM workflow_versions v
		JOIN workflows w ON w.workspace_id = v.workspace_id AND w.id = v.workflow_id
		WHERE position($1 in v.normalized_yaml) > 0
		UNION ALL
		SELECT 'execution', w.id::text, w.slug, w.name, v.id::text, v.version_number, e.id::text, e.status
		FROM executions e
		JOIN workflow_versions v ON v.workspace_id = e.workspace_id AND v.id = e.workflow_version_id
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE position($1 in v.normalized_yaml) > 0
		  AND e.status IN ('queued', 'pinned', 'running')
		ORDER BY 1, 3
	`, credentialID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []CredentialRef
	for rows.Next() {
		var ref CredentialRef
		if err := rows.Scan(
			&ref.Kind, &ref.WorkflowID, &ref.WorkflowSlug, &ref.WorkflowName,
			&ref.VersionID, &ref.VersionNumber, &ref.ExecutionID, &ref.ExecutionStatus,
		); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []CredentialRef{}
	}
	return out, nil
}

func (p *Postgres) GetExecution(ctx context.Context, scope isolation.Scope, workflowID, executionID string) (Execution, error) {
	if scope.Zero() {
		return Execution{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) || !authz.ValidUUID(executionID) {
		return Execution{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Execution{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	exec, err := scanExecution(tx.QueryRow(ctx, `
		SELECT `+executionColumns+`
		FROM executions e
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE e.workflow_id = $1::uuid AND e.id = $2::uuid
	`, workflowID, executionID))
	if err != nil {
		return Execution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Execution{}, mapDBErr(err)
	}
	return exec, nil
}

const listWorkflowSQL = `
SELECT w.id::text, w.slug, w.name, w.status, w.draft_revision,
       COALESCE(w.created_by::text, ''), COALESCE(w.updated_by::text, ''), w.created_at, w.updated_at,
       d.definition_digest,
       COALESCE(v.version_number, 0), COALESCE(v.id::text, ''), COALESCE(v.definition_digest, '')
FROM workflows w
JOIN workflow_drafts d ON d.workspace_id = w.workspace_id AND d.workflow_id = w.id
LEFT JOIN LATERAL (
    SELECT id, version_number, definition_digest
    FROM workflow_versions
    WHERE workspace_id = w.workspace_id AND workflow_id = w.id
    ORDER BY version_number DESC
    LIMIT 1
) v ON true
ORDER BY w.updated_at DESC, w.slug
`

const getWorkflowSQL = `
SELECT w.id::text, w.slug, w.name, w.status, w.draft_revision,
       COALESCE(w.created_by::text, ''), COALESCE(w.updated_by::text, ''), w.created_at, w.updated_at,
       d.definition_digest,
       COALESCE(v.version_number, 0), COALESCE(v.id::text, ''), COALESCE(v.definition_digest, '')
FROM workflows w
JOIN workflow_drafts d ON d.workspace_id = w.workspace_id AND d.workflow_id = w.id
LEFT JOIN LATERAL (
    SELECT id, version_number, definition_digest
    FROM workflow_versions
    WHERE workspace_id = w.workspace_id AND workflow_id = w.id
    ORDER BY version_number DESC
    LIMIT 1
) v ON true
WHERE w.id = $1::uuid
`

const getDraftSQL = `
SELECT workflow_id::text, revision, normalized_yaml, definition_digest, parsed_definition,
       validation_state, COALESCE(updated_by::text, ''), updated_at
FROM workflow_drafts
WHERE workflow_id = $1::uuid
`

const getVersionSQL = `
SELECT id::text, workflow_id::text, version_number, normalized_yaml, definition_digest,
       parsed_definition, publish_note, COALESCE(published_by::text, ''), published_at
FROM workflow_versions
WHERE workflow_id = $1::uuid AND id = $2::uuid
`

func insertDraft(ctx context.Context, tx pgx.Tx, scope isolation.Scope, workflowID string, revision int64, yamlDoc, digest string, parsed []byte, summary workflow.Summary) (Draft, error) {
	draft, err := scanDraft(tx.QueryRow(ctx, `
		INSERT INTO workflow_drafts (
			workspace_id, workflow_id, normalized_yaml, definition_digest, parsed_definition,
			validation_state, revision, updated_by
		) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, 'valid', $6, $7::uuid)
		RETURNING workflow_id::text, revision, normalized_yaml, definition_digest, parsed_definition,
		          validation_state, COALESCE(updated_by::text, ''), updated_at
	`, scope.WorkspaceID(), workflowID, yamlDoc, digest, parsed, revision, actorArg(scope)))
	if err != nil {
		return Draft{}, err
	}
	draft.Summary = summary
	return draft, nil
}

func requireWorkflow(ctx context.Context, tx pgx.Tx, workflowID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM workflows WHERE id = $1::uuid`, workflowID).Scan(&id)
	if err != nil {
		return mapDBErr(err)
	}
	return nil
}

func resolveCompareTx(ctx context.Context, tx pgx.Tx, workflowID string, ref CompareRef) (compareDoc, CompareRef, error) {
	switch strings.TrimSpace(ref.Kind) {
	case RefDraft, "":
		if ref.VersionID != "" || ref.VersionNumber != 0 {
			return compareDoc{}, CompareRef{}, ErrInvalid
		}
		draft, err := scanDraft(tx.QueryRow(ctx, getDraftSQL, workflowID))
		if err != nil {
			return compareDoc{}, CompareRef{}, err
		}
		return compareDoc{yaml: draft.DefinitionYAML, digest: draft.Digest, summary: draft.Summary}, CompareRef{Kind: RefDraft}, nil
	case RefVersion:
		if ref.VersionID != "" {
			if !authz.ValidUUID(ref.VersionID) {
				return compareDoc{}, CompareRef{}, ErrInvalid
			}
			ver, err := scanVersion(tx.QueryRow(ctx, getVersionSQL, workflowID, ref.VersionID))
			if err != nil {
				return compareDoc{}, CompareRef{}, err
			}
			return compareDoc{yaml: ver.DefinitionYAML, digest: ver.Digest, summary: ver.Summary}, CompareRef{Kind: RefVersion, VersionID: ver.ID, VersionNumber: ver.VersionNumber}, nil
		}
		if ref.VersionNumber < 1 {
			return compareDoc{}, CompareRef{}, ErrInvalid
		}
		ver, err := scanVersion(tx.QueryRow(ctx, `
			SELECT id::text, workflow_id::text, version_number, normalized_yaml, definition_digest,
			       parsed_definition, publish_note, COALESCE(published_by::text, ''), published_at
			FROM workflow_versions
			WHERE workflow_id = $1::uuid AND version_number = $2
		`, workflowID, ref.VersionNumber))
		if err != nil {
			return compareDoc{}, CompareRef{}, err
		}
		return compareDoc{yaml: ver.DefinitionYAML, digest: ver.Digest, summary: ver.Summary}, CompareRef{Kind: RefVersion, VersionID: ver.ID, VersionNumber: ver.VersionNumber}, nil
	default:
		return compareDoc{}, CompareRef{}, ErrInvalid
	}
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanWorkflow(row rowScanner) (Workflow, error) {
	var wf Workflow
	if err := row.Scan(
		&wf.ID, &wf.Slug, &wf.Name, &wf.Status, &wf.DraftRevision,
		&wf.CreatedBy, &wf.UpdatedBy, &wf.CreatedAt, &wf.UpdatedAt,
		&wf.DraftDigest, &wf.LatestVersionNumber, &wf.LatestVersionID, &wf.LatestVersionDigest,
	); err != nil {
		return Workflow{}, mapDBErr(err)
	}
	return wf, nil
}

func scanDraft(row rowScanner) (Draft, error) {
	var d Draft
	var raw []byte
	if err := row.Scan(
		&d.WorkflowID, &d.Revision, &d.DefinitionYAML, &d.Digest, &raw,
		&d.ValidationState, &d.UpdatedBy, &d.UpdatedAt,
	); err != nil {
		return Draft{}, mapDBErr(err)
	}
	if err := json.Unmarshal(raw, &d.Summary); err != nil {
		d.Summary = workflow.Summary{}
	}
	d.Warnings = []workflow.FieldError{}
	return d, nil
}

func scanVersion(row rowScanner) (Version, error) {
	var v Version
	var raw []byte
	if err := row.Scan(
		&v.ID, &v.WorkflowID, &v.VersionNumber, &v.DefinitionYAML, &v.Digest, &raw,
		&v.PublishNote, &v.PublishedBy, &v.PublishedAt,
	); err != nil {
		return Version{}, mapDBErr(err)
	}
	if err := json.Unmarshal(raw, &v.Summary); err != nil {
		v.Summary = workflow.Summary{}
	}
	return v, nil
}

func actorArg(scope isolation.Scope) any {
	if scope.ActorID() == "" {
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
			if pgErr.ConstraintName == "workflow_versions_digest_unique" {
				return ErrDuplicateVersion
			}
			if pgErr.ConstraintName == "executions_idempotency_uidx" {
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
