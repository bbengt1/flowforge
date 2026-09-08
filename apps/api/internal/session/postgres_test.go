package session

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresSessionLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	users := identity.NewPostgres(pool)
	suffix := newID()[:8]
	user, err := users.UpsertUser(ctx, "https://idp.example", "sess-"+suffix, "Session User")
	if err != nil {
		t.Fatal(err)
	}

	store := NewPostgres(pool)
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	issued, err := store.Create(ctx, user.ID, now, time.Minute, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Lookup(ctx, issued.Token, now.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got.UserID != user.ID {
		t.Fatalf("user %s want %s", got.UserID, user.ID)
	}
	if !CSRFMatches(got, issued.CSRF) {
		t.Fatal("csrf mismatch")
	}

	if _, err := store.Lookup(ctx, issued.Token, now.Add(2*time.Minute)); err != ErrExpired {
		t.Fatalf("idle expiry: %v", err)
	}

	refreshed, err := store.Refresh(ctx, issued.Token, issued.CSRF, now.Add(30*time.Second), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.CSRF == issued.CSRF {
		t.Fatal("csrf should rotate")
	}

	if err := store.Audit(ctx, AuditEvent{
		UserID:    user.ID,
		SessionID: issued.Record.ID,
		EventType: EventCreated,
		Outcome:   OutcomeAllowed,
		Reason:    "issued",
		RequestID: "caller-request-16",
		CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	events, err := store.ListAudit(ctx, user.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 {
		t.Fatal("expected audit row")
	}

	if _, err := store.Revoke(ctx, issued.Token, now.Add(40*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Lookup(ctx, issued.Token, now.Add(40*time.Second)); err != ErrRevoked {
		t.Fatalf("revoked: %v", err)
	}
}

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	return dsn
}
