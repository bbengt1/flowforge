package wfstore

import (
	"context"
	"errors"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestMemoryFoldersDepthCycleAndMove(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	other, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}

	l1, err := store.CreateFolder(ctx, scope, CreateFolderInput{Name: "L1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetFolder(ctx, other, l1.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace get: %v", err)
	}
	l2, err := store.CreateFolder(ctx, scope, CreateFolderInput{Name: "L2", ParentID: l1.ID})
	if err != nil {
		t.Fatal(err)
	}
	l3, err := store.CreateFolder(ctx, scope, CreateFolderInput{Name: "L3", ParentID: l2.ID})
	if err != nil {
		t.Fatal(err)
	}
	l4, err := store.CreateFolder(ctx, scope, CreateFolderInput{Name: "L4", ParentID: l3.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateFolder(ctx, scope, CreateFolderInput{Name: "L5", ParentID: l4.ID}); !errors.Is(err, ErrFolderDepth) {
		t.Fatalf("depth: %v", err)
	}
	if _, err := store.UpdateFolder(ctx, scope, l1.ID, UpdateFolderInput{ParentID: &l4.ID}); !errors.Is(err, ErrFolderCycle) {
		t.Fatalf("cycle: %v", err)
	}

	normalized := mustNormalize(t, fixtureYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
		FolderID:       l2.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFolder(ctx, scope, l2.ID); !errors.Is(err, ErrFolderNotEmpty) {
		t.Fatalf("non-empty: %v", err)
	}
	moved, err := store.SetWorkflowFolder(ctx, scope, wf.ID, l1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.DraftRevision != 1 || moved.FolderID == nil || *moved.FolderID != l1.ID {
		t.Fatalf("move: %+v", moved)
	}
	unfiled := ""
	movedFolder, err := store.UpdateFolder(ctx, scope, l2.ID, UpdateFolderInput{ParentID: &unfiled})
	if err != nil {
		t.Fatal(err)
	}
	if movedFolder.ParentID != nil {
		t.Fatalf("re-parent to top: %+v", movedFolder)
	}
	child, err := store.GetFolder(ctx, scope, l3.ID)
	if err != nil || child.ParentID == nil || *child.ParentID != l2.ID {
		t.Fatalf("children should stay with moved node: %+v %v", child, err)
	}
	if err := store.DeleteFolder(ctx, scope, l4.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFolder(ctx, scope, l3.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFolder(ctx, scope, l2.ID); err != nil {
		t.Fatal(err)
	}
}
