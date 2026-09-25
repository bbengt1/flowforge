package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
)

func TestPostgresSoftDeleteSlugAndActiveExecution(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
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

	store := NewPostgres(app)
	schedules := schedule.NewPostgres(app)
	wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scopeA, err := isolation.AuthorizeTenancy(wsA, userID, "", "bench")
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}
	normalized := mustNormalize(t, fixtureYAML)
	wf, draft, err := store.Create(ctx, scopeA, CreateInput{
		Slug:           "soft-delete-me",
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scopeA, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "pin"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := schedules.Create(ctx, scopeA, time.Now().UTC(), schedule.CreateInput{
		WorkflowID:        wf.ID,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Timezone:          "UTC",
		Interval:          "PT15M",
	}); err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scopeA, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Delete(ctx, scopeA, wf.ID); !errors.Is(err, ErrActiveExecutions) {
		t.Fatalf("queued delete = %v", err)
	}
	if _, err := store.CancelExecution(ctx, scopeA, time.Now().UTC(), exec.ID); err != nil {
		t.Fatal(err)
	}
	result, err := store.Delete(ctx, scopeA, wf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Published {
		t.Fatal("expected published flag")
	}
	if _, err := store.Get(ctx, scopeA, wf.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get = %v", err)
	}
	if _, err := store.Get(ctx, scopeB, wf.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other workspace = %v", err)
	}
	if _, err := store.GetVersion(ctx, scopeA, wf.ID, ver.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("version = %v", err)
	}
	listed, err := schedules.List(ctx, scopeA, wf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Status != schedule.StatusDisabled {
		t.Fatalf("schedules = %+v", listed)
	}
	_, _, err = store.Create(ctx, scopeA, CreateInput{
		Slug:           "soft-delete-me",
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if !errors.Is(err, ErrSlugReserved) {
		t.Fatalf("reserved slug = %v", err)
	}
	live, _, err := store.Create(ctx, scopeA, CreateInput{
		Slug:           "soft-delete-live",
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.Create(ctx, scopeA, CreateInput{
		Slug:           live.Slug,
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("live slug = %v", err)
	}
}

func TestPostgresDeleteAndStartCloseTheRowLockRace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
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
	store := NewPostgres(app)
	wsA, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	normalized := mustNormalize(t, fixtureYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	errCh := make(chan error, 1)
	startCtx := WithWorkflowRowLockHook(ctx, func() {
		go func() {
			close(started)
			_, err := store.Delete(context.Background(), scope, wf.ID)
			errCh <- err
		}()
		<-started
	})
	if _, err := store.StartExecution(startCtx, scope, wf.ID, StartInput{VersionID: ver.ID}); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; !errors.Is(err, ErrActiveExecutions) {
		t.Fatalf("delete = %v", err)
	}
}
