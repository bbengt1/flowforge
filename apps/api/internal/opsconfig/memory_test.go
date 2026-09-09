package opsconfig

import (
	"context"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestMemoryPublishPinAndIsolation(t *testing.T) {
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

	rec, draft, err := store.Create(ctx, scope, CreateInput{
		Kind: KindRecipientList,
		Name: "Oncall",
		Spec: map[string]any{"recipientPolicy": map[string]any{"emails": []string{"ops@example.com"}}},
	})
	if err != nil || draft.Revision != 1 {
		t.Fatalf("create: %+v %v", rec, err)
	}
	if _, err := store.Select(ctx, scope, KindRecipientList, rec.ID, SelectInput{}); err != ErrDraftNotUsable {
		t.Fatalf("select draft = %v", err)
	}
	_, ver, err := store.Publish(ctx, scope, KindRecipientList, rec.ID, PublishInput{ExpectedRevision: 1, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	pin, err := store.Select(ctx, scope, KindRecipientList, rec.ID, SelectInput{})
	if err != nil || pin.VersionID != ver.ID {
		t.Fatalf("select = %+v %v", pin, err)
	}
	if _, err := store.Get(ctx, other, KindRecipientList, rec.ID); err != ErrNotFound {
		t.Fatalf("cross-workspace get = %v", err)
	}
	if _, err := store.Select(ctx, other, KindRecipientList, rec.ID, SelectInput{}); err != ErrNotFound {
		t.Fatalf("cross-workspace select = %v", err)
	}

	_, draft2, err := store.SaveDraft(ctx, scope, KindRecipientList, rec.ID, SaveInput{
		ExpectedRevision: 1,
		Spec:             map[string]any{"recipientPolicy": map[string]any{"emails": []string{"noc@example.com"}}},
	})
	if err != nil || draft2.Revision != 2 {
		t.Fatalf("save: %+v %v", draft2, err)
	}
	stable, err := store.Select(ctx, scope, KindRecipientList, rec.ID, SelectInput{VersionID: ver.ID})
	if err != nil || stable.Digest != ver.Digest {
		t.Fatalf("pin drifted: %+v", stable)
	}
	if _, err := store.BindPins(ctx, scope, BindInput{OwnerKind: OwnerWorkflowVersion, OwnerID: "44444444-4444-4444-8444-444444444444", Pins: []Pin{pin}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BindPins(ctx, scope, BindInput{OwnerKind: OwnerWorkflowVersion, OwnerID: "44444444-4444-4444-8444-444444444444", Pins: []Pin{pin}}); err != ErrImmutable {
		t.Fatalf("rebind = %v", err)
	}
}
