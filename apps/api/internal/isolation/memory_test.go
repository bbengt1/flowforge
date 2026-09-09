package isolation

import (
	"context"
	"errors"
	"testing"
)

func TestMemoryRejectsCrossWorkspaceReadWriteLinkAndUse(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	a, err := Authorize("11111111-1111-1111-1111-111111111111", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Authorize("22222222-2222-2222-2222-222222222222", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	if err != nil {
		t.Fatal(err)
	}

	cred, err := store.Create(ctx, a, Record{Kind: KindCredential, Name: "k8s"})
	if err != nil {
		t.Fatal(err)
	}
	art, err := store.Create(ctx, a, Record{Kind: KindArtifact, Name: "log"})
	if err != nil {
		t.Fatal(err)
	}
	ch, err := store.Create(ctx, a, Record{Kind: KindRealtime, Name: "exec"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.Get(ctx, b, cred.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace read = %v", err)
	}
	items, err := store.List(ctx, b, KindCredential)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("cross-workspace list leaked %d rows", len(items))
	}
	if _, err := store.Link(ctx, b, cred.ID, KindJob); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace link = %v", err)
	}
	if err := store.UseCredential(ctx, b, cred.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace credential use = %v", err)
	}
	if _, err := store.Get(ctx, b, art.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace artifact = %v", err)
	}
	if err := store.Subscribe(ctx, b, ch.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace subscribe = %v", err)
	}

	if _, err := store.Get(ctx, Scope{}, cred.ID); !errors.Is(err, ErrNoScope) {
		t.Fatalf("unset scope get = %v", err)
	}
}

func TestMemorySameWorkspaceLinkSucceeds(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	a, err := Authorize("11111111-1111-1111-1111-111111111111", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	parent, err := store.Create(ctx, a, Record{Kind: KindJob, Name: "run"})
	if err != nil {
		t.Fatal(err)
	}
	link, err := store.Link(ctx, a, parent.ID, KindArtifact)
	if err != nil {
		t.Fatal(err)
	}
	if link.ParentID != parent.ID || link.WorkspaceID != a.WorkspaceID() {
		t.Fatalf("link = %+v", link)
	}
}

func TestMemoryStampsTenantWorkbenchOnRecords(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := AuthorizeTenancy("11111111-1111-1111-1111-111111111111", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "ops")
	if err != nil {
		t.Fatal(err)
	}
	rec, err := store.Create(ctx, scope, Record{Kind: KindJob, Name: "dispatch", Metadata: map[string]any{"tenant_id": "host-supplied"}})
	if err != nil {
		t.Fatal(err)
	}
	if rec.Metadata["tenant_id"] != "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" {
		t.Fatalf("host tenant must not win: %+v", rec.Metadata)
	}
	if rec.Metadata["workbench_key"] != "ops" {
		t.Fatalf("missing workbench: %+v", rec.Metadata)
	}
}
