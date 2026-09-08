package session

import (
	"context"
	"testing"
	"time"
)

func TestMemoryCreateLookupRefreshRevoke(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)

	issued, err := store.Create(ctx, "11111111-1111-1111-1111-111111111111", now, time.Minute, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if issued.Token == "" || issued.CSRF == "" || issued.Record.ID == "" {
		t.Fatal("expected opaque token, csrf, and id")
	}
	if issued.Token == issued.CSRF {
		t.Fatal("session token and csrf must differ")
	}

	got, err := store.Lookup(ctx, issued.Token, now.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != issued.Record.ID || got.UserID != issued.Record.UserID {
		t.Fatalf("lookup mismatch: %+v", got)
	}
	if !csrfMatches(got, issued.CSRF) {
		t.Fatal("csrf must match issued token")
	}

	if _, err := store.Lookup(ctx, "not-a-session", now); err != ErrNotFound {
		t.Fatalf("unknown token: %v", err)
	}

	refreshed, err := store.Refresh(ctx, issued.Token, now.Add(40*time.Second), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.CSRF == issued.CSRF {
		t.Fatal("refresh must rotate csrf")
	}
	if refreshed.Record.IdleExpiresAt.Equal(issued.Record.IdleExpiresAt) {
		t.Fatal("refresh must extend idle expiry")
	}

	if _, err := store.Lookup(ctx, issued.Token, now.Add(2*time.Minute)); err != ErrExpired {
		t.Fatalf("idle expiry: %v", err)
	}

	if _, err := store.Revoke(ctx, issued.Token, now.Add(10*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Lookup(ctx, issued.Token, now.Add(10*time.Second)); err != ErrRevoked {
		t.Fatalf("revoked: %v", err)
	}
}

func TestMemoryRefreshCannotExceedAbsolute(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	issued, err := store.Create(ctx, "11111111-1111-1111-1111-111111111111", now, time.Hour, 90*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	refreshed, err := store.Refresh(ctx, issued.Token, now.Add(40*time.Minute), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed.Record.IdleExpiresAt.Equal(issued.Record.AbsoluteExpiresAt) {
		t.Fatalf("idle %s want absolute cap %s", refreshed.Record.IdleExpiresAt, issued.Record.AbsoluteExpiresAt)
	}
	if _, err := store.Lookup(ctx, issued.Token, now.Add(90*time.Minute)); err != ErrExpired {
		t.Fatalf("absolute expiry: %v", err)
	}
}

func TestMemoryAuditOmitsEmptyUser(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	if err := store.Audit(ctx, AuditEvent{
		UserID:    "user-1",
		EventType: EventCreated,
		Outcome:   OutcomeAllowed,
		Reason:    "issued",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Audit(ctx, AuditEvent{
		UserID:    "user-2",
		EventType: EventCSRFRejected,
		Outcome:   OutcomeDenied,
		Reason:    "missing token",
	}); err != nil {
		t.Fatal(err)
	}
	items, err := store.ListAudit(ctx, "user-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].EventType != EventCreated {
		t.Fatalf("items = %+v", items)
	}
}
