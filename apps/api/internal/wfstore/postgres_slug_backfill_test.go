package wfstore

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgxpool"
)

// draftRow is every draft column the backfill could change, read as the
// owner so RLS does not hide it.
type draftRow struct {
	yaml, digest, parsed, state, updatedBy string
	revision, wfRevision                   int64
	updatedAt, wfUpdatedAt                 time.Time
}

func readDraftRow(t *testing.T, ctx context.Context, admin *pgxpool.Pool, id string) draftRow {
	t.Helper()
	var r draftRow
	err := admin.QueryRow(ctx, `
		SELECT d.normalized_yaml, d.definition_digest, d.parsed_definition::text, d.validation_state,
		       COALESCE(d.updated_by::text, ''), d.revision, w.draft_revision, d.updated_at, w.updated_at
		  FROM workflow_drafts d
		  JOIN workflows w ON w.workspace_id = d.workspace_id AND w.id = d.workflow_id
		 WHERE d.workflow_id = $1::uuid
	`, id).Scan(&r.yaml, &r.digest, &r.parsed, &r.state, &r.updatedBy, &r.revision, &r.wfRevision, &r.updatedAt, &r.wfUpdatedAt)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func readVersionRows(t *testing.T, ctx context.Context, admin *pgxpool.Pool, id string) []string {
	t.Helper()
	rows, err := admin.Query(ctx, `
		SELECT normalized_yaml || '|' || definition_digest || '|' || parsed_definition::text
		  FROM workflow_versions WHERE workflow_id = $1::uuid ORDER BY version_number
	`, id)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPostgresDraftSlugBackfill(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	editorA, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	editorB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}
	// The command's scope: a workspace from the session setting, no actor.
	runA, err := isolation.AuthorizeSystem(wsA)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPostgres(app)
	hooks := postgresDraftSlugHooks(ctx, admin)
	drift := func(t *testing.T, id, name, slug string) {
		t.Helper()
		yamlDoc, digest, _, err := stampWorkflowSlug(mustNormalize(t, slugYAML(name, "")).NormalizedYAML, slug)
		if err != nil {
			t.Fatal(err)
		}
		hooks.setDraft(t, id, yamlDoc, digest)
	}

	drifted := createNamed(t, ctx, store, editorA, "Bf Drift", "")
	drift(t, drifted.ID, "Bf Drift", "bf-old")
	missing := createNamed(t, ctx, store, editorA, "Bf Missing", "")
	drift(t, missing.ID, "Bf Missing", "")
	clean := createNamed(t, ctx, store, editorA, "Bf Clean", "")
	published := createNamed(t, ctx, store, editorA, "Bf Published", "")
	drift(t, published.ID, "Bf Published", "bf-published-old")
	if _, _, err := store.Publish(ctx, editorA, published.ID, PublishInput{ExpectedRevision: 1, Note: "stale"}); err != nil {
		t.Fatal(err)
	}
	deleted := createNamed(t, ctx, store, editorA, "Bf Deleted", "")
	drift(t, deleted.ID, "Bf Deleted", "bf-deleted-old")
	if _, err := store.Delete(ctx, editorA, deleted.ID); err != nil {
		t.Fatal(err)
	}
	other := createNamed(t, ctx, store, editorB, "Bf Other", "")
	drift(t, other.ID, "Bf Other", "bf-other-old")

	if slug, err := metadataSlug(readDraftRow(t, ctx, admin, missing.ID).yaml); err != nil || slug != "" {
		t.Fatalf("missing draft slug = %q %v", slug, err)
	}
	beforeDrifted := readDraftRow(t, ctx, admin, drifted.ID)
	beforeClean := readDraftRow(t, ctx, admin, clean.ID)
	beforeDeleted := readDraftRow(t, ctx, admin, deleted.ID)
	beforeOther := readDraftRow(t, ctx, admin, other.ID)
	beforeVersions := readVersionRows(t, ctx, admin, published.ID)
	if len(beforeVersions) != 1 {
		t.Fatalf("versions = %d", len(beforeVersions))
	}

	t.Run("refuses a role that bypasses RLS", func(t *testing.T) {
		var bypass bool
		if err := admin.QueryRow(ctx, `SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&bypass); err != nil {
			t.Fatal(err)
		}
		if !bypass {
			t.Skip("admin connection does not bypass RLS")
		}
		if _, err := NewPostgres(admin).BackfillDraftSlugs(ctx, runA); !errors.Is(err, ErrBackfillBypassesRLS) {
			t.Fatalf("admin backfill = %v", err)
		}
		if readDraftRow(t, ctx, admin, drifted.ID) != beforeDrifted {
			t.Fatal("refused backfill changed a draft")
		}
	})

	t.Run("restricted role cannot reach another workspace", func(t *testing.T) {
		var role string
		var bypass bool
		tx, err := postgres.BeginScoped(ctx, app, wsA)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `SELECT current_user, rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&role, &bypass); err != nil {
			t.Fatal(err)
		}
		tag, err := tx.Exec(ctx, `UPDATE workflow_drafts SET revision = revision + 1 WHERE workflow_id = $1::uuid`, other.ID)
		if err != nil {
			t.Fatal(err)
		}
		_ = tx.Rollback(ctx)
		if role != postgres.AppRole || bypass {
			t.Fatalf("app pool role = %s bypass=%v", role, bypass)
		}
		if tag.RowsAffected() != 0 {
			t.Fatalf("workspace A session updated %d drafts in B", tag.RowsAffected())
		}
		// Even B's workflow id gets nowhere from A's session.
		if _, _, err := store.backfillDraftSlug(ctx, runA, other.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-workspace backfill = %v", err)
		}
		if readDraftRow(t, ctx, admin, other.ID) != beforeOther {
			t.Fatal("workspace B draft changed")
		}
	})

	t.Run("first run rewrites only drifted drafts", func(t *testing.T) {
		res, err := store.BackfillDraftSlugs(ctx, runA)
		if err != nil {
			t.Fatal(err)
		}
		if res.Scanned != 4 || res.Changed != 3 || res.Skipped != 0 || len(res.Changes) != 3 {
			t.Fatalf("result = %+v", res)
		}
		wantChanges := map[string]DraftSlugChange{
			drifted.ID:   {WorkflowID: drifted.ID, OldSlug: "bf-old", NewSlug: drifted.Slug},
			missing.ID:   {WorkflowID: missing.ID, OldSlug: "", NewSlug: missing.Slug},
			published.ID: {WorkflowID: published.ID, OldSlug: "bf-published-old", NewSlug: published.Slug},
		}
		for _, c := range res.Changes {
			if wantChanges[c.WorkflowID] != c {
				t.Fatalf("change = %+v, want %+v", c, wantChanges[c.WorkflowID])
			}
		}
		for _, wf := range []Workflow{drifted, missing, published} {
			got := readDraftRow(t, ctx, admin, wf.ID)
			assertYAMLSlug(t, got.yaml, wf.Slug)
			if got.digest != workflow.Digest(got.yaml) {
				t.Fatalf("%s digest does not match yaml", wf.Slug)
			}
			want, errs := workflow.ParseAndNormalize([]byte(got.yaml))
			if len(errs) > 0 || want.NormalizedYAML != got.yaml {
				t.Fatalf("%s yaml is not normalized: %v", wf.Slug, errs)
			}
			wantParsed, _ := json.Marshal(want.Summary)
			var gotSummary, wantSummary any
			_ = json.Unmarshal([]byte(got.parsed), &gotSummary)
			_ = json.Unmarshal(wantParsed, &wantSummary)
			gj, _ := json.Marshal(gotSummary)
			wj, _ := json.Marshal(wantSummary)
			if string(gj) != string(wj) {
				t.Fatalf("%s parsed copy = %s, want %s", wf.Slug, gj, wj)
			}
			if got.updatedBy != userID {
				t.Fatalf("%s updated_by = %q, want the last editor kept", wf.Slug, got.updatedBy)
			}
			if got.revision != got.wfRevision {
				t.Fatalf("%s draft revision %d, workflow draft_revision %d", wf.Slug, got.revision, got.wfRevision)
			}
		}
		if got := readDraftRow(t, ctx, admin, drifted.ID); got.revision != beforeDrifted.revision+1 {
			t.Fatalf("revision = %d, want %d", got.revision, beforeDrifted.revision+1)
		}
		if readDraftRow(t, ctx, admin, clean.ID) != beforeClean {
			t.Fatal("clean draft changed")
		}
		if readDraftRow(t, ctx, admin, deleted.ID) != beforeDeleted {
			t.Fatal("deleted workflow's draft changed")
		}
		if got := readVersionRows(t, ctx, admin, published.ID); len(got) != 1 || got[0] != beforeVersions[0] {
			t.Fatal("published version changed")
		}
		if readDraftRow(t, ctx, admin, other.ID) != beforeOther {
			t.Fatal("workspace B draft changed")
		}
	})

	t.Run("second run changes nothing", func(t *testing.T) {
		snapshot := map[string]draftRow{}
		for _, wf := range []Workflow{drifted, missing, clean, published, deleted, other} {
			snapshot[wf.ID] = readDraftRow(t, ctx, admin, wf.ID)
		}
		versions := readVersionRows(t, ctx, admin, published.ID)
		res, err := store.BackfillDraftSlugs(ctx, runA)
		if err != nil {
			t.Fatal(err)
		}
		if res.Changed != 0 || res.Scanned != 4 || len(res.Changes) != 0 {
			t.Fatalf("second run = %+v", res)
		}
		for id, want := range snapshot {
			if got := readDraftRow(t, ctx, admin, id); got != want {
				t.Fatalf("second run changed %s:\n got %+v\nwant %+v", id, got, want)
			}
		}
		if got := readVersionRows(t, ctx, admin, published.ID); len(got) != len(versions) || got[0] != versions[0] {
			t.Fatal("second run changed a published version")
		}
	})

	t.Run("workspace B is fixed only by its own run", func(t *testing.T) {
		runB, err := isolation.AuthorizeSystem(wsB)
		if err != nil {
			t.Fatal(err)
		}
		res, err := store.BackfillDraftSlugs(ctx, runB)
		if err != nil {
			t.Fatal(err)
		}
		if res.Changed != 1 {
			t.Fatalf("workspace B run = %+v", res)
		}
		assertYAMLSlug(t, readDraftRow(t, ctx, admin, other.ID).yaml, other.Slug)
	})
}
