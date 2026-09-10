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

func TestPostgresRevokeBoundToWorkspaceAndHardDelete(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	users := identity.NewPostgres(pool)
	suffix := newID()[:8]
	user, err := users.UpsertUser(ctx, "https://idp.example", "sess-ws-"+suffix, "Session User")
	if err != nil {
		t.Fatal(err)
	}
	otherUser, err := users.UpsertUser(ctx, "https://idp.example", "sess-other-"+suffix, "Other")
	if err != nil {
		t.Fatal(err)
	}
	tenant, err := users.CreateTenant(ctx, "tw-"+suffix, "Tenant "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	otherTenant, err := users.CreateTenant(ctx, "to-"+suffix, "Other "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := users.CreateWorkspace(ctx, tenant.ID, "ops-"+suffix, "Ops", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	other, err := users.CreateWorkspace(ctx, otherTenant.ID, "other-"+suffix, "Other", otherUser.ID)
	if err != nil {
		t.Fatal(err)
	}

	store := NewPostgres(pool)
	// Wall-clock now: the hard-delete trigger stamps revoked_at with SQL now(),
	// and Valid() ignores a revoke timestamp after the lookup clock.
	now := time.Now().UTC()
	bound, err := store.Create(ctx, user.ID, now, time.Hour, 12*time.Hour, CreateOpts{
		Binding: Binding{TenantID: tenant.ID, WorkbenchKey: ws.WorkbenchKey, WorkspaceID: ws.ID, Capabilities: []string{"workflow.view"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	unrelated, err := store.Create(ctx, otherUser.ID, now, time.Hour, 12*time.Hour, CreateOpts{
		Binding: Binding{TenantID: otherTenant.ID, WorkbenchKey: other.WorkbenchKey, WorkspaceID: other.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	unbound, err := store.Create(ctx, user.ID, now, time.Hour, 12*time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	revoked, err := store.RevokeBoundToWorkspace(ctx, ws.ID, tenant.ID, ws.WorkbenchKey, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(revoked) != 1 || revoked[0].ID != bound.Record.ID {
		t.Fatalf("revoked %+v", revoked)
	}
	if _, err := store.Lookup(ctx, bound.Token, now.Add(time.Second)); err != ErrRevoked {
		t.Fatalf("bound: %v", err)
	}
	if _, err := store.Lookup(ctx, unrelated.Token, now.Add(time.Second)); err != nil {
		t.Fatalf("unrelated: %v", err)
	}
	if _, err := store.Lookup(ctx, unbound.Token, now.Add(time.Second)); err != nil {
		t.Fatalf("unbound: %v", err)
	}

	hardUser, err := users.UpsertUser(ctx, "https://idp.example", "sess-hard-"+suffix, "Hard")
	if err != nil {
		t.Fatal(err)
	}
	hardWS, err := users.CreateWorkspace(ctx, tenant.ID, "hard-"+suffix, "Hard", hardUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	hardSess, err := store.Create(ctx, hardUser.ID, now, time.Hour, 12*time.Hour, CreateOpts{
		Binding: Binding{TenantID: tenant.ID, WorkbenchKey: hardWS.WorkbenchKey, WorkspaceID: hardWS.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM workspaces WHERE id = $1::uuid`, hardWS.ID); err != nil {
		t.Fatalf("hard delete: %v", err)
	}
	if _, err := store.Lookup(ctx, hardSess.Token, now.Add(2*time.Second)); err != ErrRevoked {
		t.Fatalf("hard-delete session: %v", err)
	}
	if _, err := store.Lookup(ctx, unrelated.Token, now.Add(2*time.Second)); err != nil {
		t.Fatalf("unrelated after hard delete: %v", err)
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
