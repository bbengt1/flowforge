package wfstore

import (
	"context"
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// ErrBackfillBypassesRLS is returned when the session role can bypass row
// level security. The draft slug backfill relies on FORCE RLS for its
// workspace scope, so it refuses to run as a superuser or BYPASSRLS role.
var ErrBackfillBypassesRLS = errors.New("draft slug backfill must run as a role without SUPERUSER or BYPASSRLS")

// errDraftSlugCurrent means the locked draft already carries the stored
// slug. Nothing is written.
var errDraftSlugCurrent = errors.New("draft slug already matches the stored slug")

// DraftSlugBackfill counts the drafts seen by BackfillDraftSlugs.
type DraftSlugBackfill struct {
	// Scanned is the number of drafts of live workflows in the workspace.
	Scanned int
	// Changed is the number of drafts rewritten with the stored slug.
	Changed int
	// Skipped is the number of drafts whose YAML could not be parsed or
	// normalized. They are left as they are.
	Skipped int
	// Changes lists each rewritten draft, in the order written. Unchanged
	// drafts are not listed.
	Changes []DraftSlugChange
}

// DraftSlugChange is one draft rewritten by BackfillDraftSlugs. OldSlug
// is metadata.slug read from the locked draft YAML, empty when it was
// missing. It comes from user YAML: escape it before writing it to a log.
type DraftSlugChange struct {
	WorkflowID string
	OldSlug    string
	NewSlug    string
}

type backfillCandidate struct {
	workflowID string
	yaml       string
	storedSlug string
}

// BackfillDraftSlugs writes the stored workflow slug into metadata.slug of
// every draft in the scoped workspace where the parsed metadata.slug
// differs from it, including a missing slug (#557).
//
// It uses the draft save path. Each draft gets its own transaction that
// locks the row with SELECT ... FOR UPDATE, re-checks the slug, and writes
// the YAML, digest, and parsed copy from one normalization. The revision
// goes up, so an open editor gets a revision conflict and reloads.
//
// The workspace comes only from the session setting app.workspace_id that
// postgres.BeginScoped sets. No query names a workspace. FORCE RLS limits
// every read and write to that workspace, and the call fails closed when
// the session role could bypass RLS. Deleted workflows and published
// versions are never read for writing. A second run changes nothing.
func (p *Postgres) BackfillDraftSlugs(ctx context.Context, scope isolation.Scope) (DraftSlugBackfill, error) {
	var res DraftSlugBackfill
	if scope.Zero() {
		return res, ErrNoScope
	}
	candidates, err := p.draftSlugCandidates(ctx, scope)
	if err != nil {
		return res, err
	}
	res.Scanned = len(candidates)
	for _, c := range candidates {
		slug, perr := metadataSlug(c.yaml)
		if perr != nil {
			res.Skipped++
			continue
		}
		if strings.TrimSpace(slug) == c.storedSlug {
			continue
		}
		change, changed, err := p.backfillDraftSlug(ctx, scope, c.workflowID)
		switch {
		case err == nil:
			if changed {
				res.Changed++
				res.Changes = append(res.Changes, change)
			}
		case errors.Is(err, ErrInvalid):
			res.Skipped++
		case errors.Is(err, ErrNotFound):
			// Deleted after the scan. Deleted workflows are left alone.
		default:
			return res, err
		}
	}
	return res, nil
}

func (p *Postgres) draftSlugCandidates(ctx context.Context, scope isolation.Scope) ([]backfillCandidate, error) {
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var bypass bool
	if err := tx.QueryRow(ctx, `
		SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user
	`).Scan(&bypass); err != nil {
		return nil, mapDBErr(err)
	}
	if bypass {
		return nil, ErrBackfillBypassesRLS
	}
	rows, err := tx.Query(ctx, `
		SELECT d.workflow_id::text, d.normalized_yaml, w.slug
		  FROM workflow_drafts d
		  JOIN workflows w ON w.workspace_id = d.workspace_id AND w.id = d.workflow_id
		 WHERE w.deleted_at IS NULL
		 ORDER BY d.workflow_id
	`)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []backfillCandidate
	for rows.Next() {
		var c backfillCandidate
		if err := rows.Scan(&c.workflowID, &c.yaml, &c.storedSlug); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

// backfillDraftSlug rewrites one draft through saveDraftTx. It reports
// false when the locked row already carries the stored slug. The change
// holds the slugs read from the locked row.
func (p *Postgres) backfillDraftSlug(ctx context.Context, scope isolation.Scope, workflowID string) (DraftSlugChange, bool, error) {
	change := DraftSlugChange{WorkflowID: workflowID}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return change, false, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	_, _, err = saveDraftTx(ctx, tx, scope, workflowID, scope.ActorID() == "", func(locked lockedDraft) (SaveInput, error) {
		doc, errs := workflow.Parse([]byte(locked.yaml))
		if len(errs) > 0 || doc == nil {
			return SaveInput{}, ErrInvalid
		}
		if strings.TrimSpace(doc.Metadata.Slug) == locked.storedSlug {
			return SaveInput{}, errDraftSlugCurrent
		}
		change.OldSlug = strings.TrimSpace(doc.Metadata.Slug)
		change.NewSlug = locked.storedSlug
		return SaveInput{
			NormalizedYAML:   locked.yaml,
			Digest:           workflow.Digest(locked.yaml),
			Summary:          doc.Summary(),
			ExpectedRevision: locked.revision,
		}, nil
	})
	if errors.Is(err, errDraftSlugCurrent) {
		return change, false, nil
	}
	if err != nil {
		return change, false, err
	}
	return change, true, nil
}
