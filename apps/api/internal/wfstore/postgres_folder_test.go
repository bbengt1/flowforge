package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresFoldersIsolationAndUniqueSiblings(t *testing.T) {
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
	wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scopeA, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}

	folder, err := store.CreateFolder(ctx, scopeA, CreateFolderInput{Name: "Ops"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetFolder(ctx, scopeB, folder.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace folder: %v", err)
	}
	if _, err := store.CreateFolder(ctx, scopeA, CreateFolderInput{Name: "ops"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("sibling uniqueness: %v", err)
	}
	if _, err := store.CreateFolder(ctx, scopeB, CreateFolderInput{Name: "Ops"}); err != nil {
		t.Fatalf("other workspace may reuse name: %v", err)
	}

	normalized := mustNormalize(t, fixtureYAML)
	wf, _, err := store.Create(ctx, scopeA, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
		FolderID:       folder.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if wf.FolderID == nil || *wf.FolderID != folder.ID {
		t.Fatalf("create folderId: %+v", wf)
	}
	if err := store.DeleteFolder(ctx, scopeA, folder.ID); !errors.Is(err, ErrFolderNotEmpty) {
		t.Fatalf("non-empty delete: %v", err)
	}
	moved, err := store.SetWorkflowFolder(ctx, scopeA, wf.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if moved.FolderID != nil || moved.DraftRevision != 1 {
		t.Fatalf("move unfiled: %+v", moved)
	}
	if err := store.DeleteFolder(ctx, scopeA, folder.ID); err != nil {
		t.Fatal(err)
	}
}
