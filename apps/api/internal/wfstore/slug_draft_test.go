package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgxpool"
)

// draftSlugHooks reach under the store to build drift a pre-#557 save
// could leave behind: a draft whose metadata.slug differs from the stored
// slug, and a legacy stored slug that today's create would reject.
type draftSlugHooks struct {
	setDraft func(t *testing.T, id, yamlDoc, digest string)
	setSlug  func(t *testing.T, id, slug string)
}

func TestMemoryDraftSlugIsImmutable(t *testing.T) {
	store := NewMemory()
	hooks := draftSlugHooks{
		setDraft: func(t *testing.T, id, yamlDoc, digest string) {
			store.mu.Lock()
			defer store.mu.Unlock()
			row := store.workflows[id]
			row.draft.DefinitionYAML = yamlDoc
			row.draft.Digest = digest
			store.workflows[id] = row
		},
		setSlug: func(t *testing.T, id, slug string) {
			store.mu.Lock()
			defer store.mu.Unlock()
			row := store.workflows[id]
			row.record.Slug = slug
			store.workflows[id] = row
		},
	}
	assertDraftSlugRules(t, context.Background(), store, testWorkflowScope(t), hooks)
}

func TestPostgresDraftSlugIsImmutable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
	wsA, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	assertDraftSlugRules(t, ctx, NewPostgres(app), scope, postgresDraftSlugHooks(ctx, admin))
}

func postgresDraftSlugHooks(ctx context.Context, admin *pgxpool.Pool) draftSlugHooks {
	return draftSlugHooks{
		setDraft: func(t *testing.T, id, yamlDoc, digest string) {
			t.Helper()
			if _, err := admin.Exec(ctx, `
				UPDATE workflow_drafts SET normalized_yaml = $2, definition_digest = $3 WHERE workflow_id = $1::uuid
			`, id, yamlDoc, digest); err != nil {
				t.Fatal(err)
			}
		},
		setSlug: func(t *testing.T, id, slug string) {
			t.Helper()
			if _, err := admin.Exec(ctx, `UPDATE workflows SET slug = $2 WHERE id = $1::uuid`, id, slug); err != nil {
				t.Fatal(err)
			}
		},
	}
}

func assertDraftSlugRules(t *testing.T, ctx context.Context, store Store, scope isolation.Scope, hooks draftSlugHooks) {
	t.Helper()

	save := func(t *testing.T, id string, revision int64, name, slug string) (Draft, error) {
		t.Helper()
		normalized := mustNormalize(t, slugYAML(name, slug))
		_, draft, err := store.SaveDraft(ctx, scope, id, SaveInput{
			ExpectedRevision: revision,
			NormalizedYAML:   normalized.NormalizedYAML,
			Digest:           normalized.Digest,
			Summary:          normalized.Summary,
		})
		return draft, err
	}
	drift := func(t *testing.T, id, name, slug string) {
		t.Helper()
		yamlDoc, digest, _, err := stampWorkflowSlug(mustNormalize(t, slugYAML(name, "")).NormalizedYAML, slug)
		if err != nil {
			t.Fatal(err)
		}
		hooks.setDraft(t, id, yamlDoc, digest)
	}

	t.Run("missing slug is filled from the stored slug", func(t *testing.T) {
		wf := createNamed(t, ctx, store, scope, "Save Missing", "")
		draft, err := save(t, wf.ID, 1, "Save Missing v2", "")
		if err != nil {
			t.Fatal(err)
		}
		if draft.Revision != 2 {
			t.Fatalf("revision = %d", draft.Revision)
		}
		assertYAMLSlug(t, draft.DefinitionYAML, "save-missing")
		assertStoredSlug(t, ctx, store, scope, wf.ID, "save-missing")
		got, err := store.Get(ctx, scope, wf.ID)
		if err != nil || got.Name != "Save Missing v2" || got.Slug != "save-missing" || got.DraftDigest != draft.Digest {
			t.Fatalf("rename kept slug: %+v %v", got, err)
		}
	})

	t.Run("unchanged slug saves", func(t *testing.T) {
		wf := createNamed(t, ctx, store, scope, "Save Same", "")
		draft, err := save(t, wf.ID, 1, "Save Same", "save-same")
		if err != nil {
			t.Fatal(err)
		}
		assertYAMLSlug(t, draft.DefinitionYAML, "save-same")
	})

	t.Run("changed slug is immutable and writes nothing", func(t *testing.T) {
		wf := createNamed(t, ctx, store, scope, "Save Change", "")
		before, err := store.GetDraft(ctx, scope, wf.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := save(t, wf.ID, 1, "Save Change", "something-else"); !errors.Is(err, ErrSlugImmutable) {
			t.Fatalf("change = %v", err)
		}
		after, err := store.GetDraft(ctx, scope, wf.ID)
		if err != nil {
			t.Fatal(err)
		}
		if after.Revision != before.Revision || after.Digest != before.Digest || after.DefinitionYAML != before.DefinitionYAML {
			t.Fatalf("refused save changed the draft: %+v", after)
		}
	})

	t.Run("drifted draft saves and gets the stored slug back", func(t *testing.T) {
		wf := createNamed(t, ctx, store, scope, "Drift Me", "")
		drift(t, wf.ID, "Drift Me", "drifted-old")
		draft, err := save(t, wf.ID, 1, "Drift Me", "drifted-old")
		if err != nil {
			t.Fatalf("drifted save = %v", err)
		}
		assertYAMLSlug(t, draft.DefinitionYAML, "drift-me")
		assertStoredSlug(t, ctx, store, scope, wf.ID, "drift-me")
		// The drift is gone now, so the old value counts as a change.
		if _, err := save(t, wf.ID, 2, "Drift Me", "drifted-old"); !errors.Is(err, ErrSlugImmutable) {
			t.Fatalf("second drifted save = %v", err)
		}
	})

	t.Run("legacy trailing-hyphen slug saves, publishes, exports and restores", func(t *testing.T) {
		wf := createNamed(t, ctx, store, scope, "Legacy Trail", "")
		hooks.setSlug(t, wf.ID, "qa-546-trail-")
		drift(t, wf.ID, "Legacy Trail", "qa-546-trail-")
		draft, err := save(t, wf.ID, 1, "Legacy Trail", "qa-546-trail-")
		if err != nil {
			t.Fatalf("legacy save = %v", err)
		}
		assertYAMLSlug(t, draft.DefinitionYAML, "qa-546-trail-")
		draft, err = save(t, wf.ID, draft.Revision, "Legacy Trail v2", "")
		if err != nil {
			t.Fatalf("legacy save without slug = %v", err)
		}
		assertYAMLSlug(t, draft.DefinitionYAML, "qa-546-trail-")
		_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
		if err != nil {
			t.Fatal(err)
		}
		exported, err := store.GetVersion(ctx, scope, wf.ID, ver.ID)
		if err != nil {
			t.Fatal(err)
		}
		assertYAMLSlug(t, exported.DefinitionYAML, "qa-546-trail-")
		restored, err := restoreVersion(ctx, store, scope, wf.ID, ver.ID)
		if err != nil {
			t.Fatal(err)
		}
		assertYAMLSlug(t, restored.DefinitionYAML, "qa-546-trail-")
		got, err := store.Get(ctx, scope, wf.ID)
		if err != nil || got.Slug != "qa-546-trail-" {
			t.Fatalf("legacy slug = %+v %v", got, err)
		}
	})

	t.Run("restore writes the stored slug into the draft", func(t *testing.T) {
		wf := createNamed(t, ctx, store, scope, "Restore Me", "")
		drift(t, wf.ID, "Restore Me", "restore-old")
		_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1, Note: "drifted"})
		if err != nil {
			t.Fatal(err)
		}
		assertYAMLSlug(t, ver.DefinitionYAML, "restore-old")
		restored, err := restoreVersion(ctx, store, scope, wf.ID, ver.ID)
		if err != nil {
			t.Fatal(err)
		}
		assertYAMLSlug(t, restored.DefinitionYAML, "restore-me")
		if workflow.Digest(restored.DefinitionYAML) != restored.Digest {
			t.Fatal("restored digest does not match yaml")
		}
		assertStoredSlug(t, ctx, store, scope, wf.ID, "restore-me")
		// Publishing the restored draft exports the stored slug. The old
		// version keeps its stale slug: history is never rewritten.
		_, v2, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: restored.Revision, Note: "restored"})
		if err != nil {
			t.Fatal(err)
		}
		exported, err := store.GetVersion(ctx, scope, wf.ID, v2.ID)
		if err != nil {
			t.Fatal(err)
		}
		assertYAMLSlug(t, exported.DefinitionYAML, "restore-me")
		old, err := store.GetVersion(ctx, scope, wf.ID, ver.ID)
		if err != nil {
			t.Fatal(err)
		}
		if old.DefinitionYAML != ver.DefinitionYAML || old.Digest != ver.Digest {
			t.Fatal("restore rewrote the published version")
		}
	})

	t.Run("restore of a matching version keeps its digest", func(t *testing.T) {
		wf := createNamed(t, ctx, store, scope, "Restore Clean", "")
		_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1, Note: "clean"})
		if err != nil {
			t.Fatal(err)
		}
		restored, err := restoreVersion(ctx, store, scope, wf.ID, ver.ID)
		if err != nil {
			t.Fatal(err)
		}
		if restored.Digest != ver.Digest || restored.DefinitionYAML != ver.DefinitionYAML {
			t.Fatalf("restore changed a matching version: %s vs %s", restored.Digest, ver.Digest)
		}
	})
}

func restoreVersion(ctx context.Context, store Store, scope isolation.Scope, workflowID, versionID string) (Draft, error) {
	_, draft, err := store.Restore(ctx, scope, workflowID, RestoreInput{VersionID: versionID})
	return draft, err
}
