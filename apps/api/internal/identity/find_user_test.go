package identity

import (
	"context"
	"testing"
)

func TestFindUserDoesNotUpsert(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	if _, err := store.FindUser(ctx, "https://idp.example", "missing-subject"); err != ErrNotFound {
		t.Fatalf("missing: %v", err)
	}
	if store.HasPrincipal("https://idp.example", "missing-subject") {
		t.Fatal("FindUser upserted a principal")
	}
	created, err := store.UpsertUser(ctx, "https://idp.example", "runner-1", "Runner")
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.FindUser(ctx, "https://idp.example", "runner-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != created.ID || got.DisplayName != "Runner" {
		t.Fatalf("found %+v", got)
	}
	if _, err := store.FindUser(ctx, "", "runner-1"); err != ErrInvalid {
		t.Fatalf("invalid: %v", err)
	}
}
