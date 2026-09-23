package quota

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresBucketsIsolateWorkspaces(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	ids := identity.NewPostgres(app)
	suffix := time.Now().UnixNano()
	user, err := ids.UpsertUser(ctx, "https://idp.example", fmt.Sprintf("quota-%d", suffix), "Quota")
	if err != nil {
		t.Fatal(err)
	}
	tenant, err := ids.CreateTenant(ctx, fmt.Sprintf("q%d", suffix%1_000_000_000), "Quota")
	if err != nil {
		t.Fatal(err)
	}
	wsA, err := ids.CreateWorkspace(ctx, tenant.ID, "a", "A", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	wsB, err := ids.CreateWorkspace(ctx, tenant.ID, "b", "B", user.ID)
	if err != nil {
		t.Fatal(err)
	}

	store := NewPostgres(app)
	now := time.Date(2026, 9, 23, 15, 0, 0, 0, time.UTC)
	ok, err := store.Take(ctx, wsA.ID, ClassExecute, 1, 1.0/60.0, now)
	if err != nil || !ok.Allowed {
		t.Fatalf("workspace A allow: %+v %v", ok, err)
	}
	denied, err := store.Take(ctx, wsA.ID, ClassExecute, 1, 1.0/60.0, now)
	if err != nil || denied.Allowed {
		t.Fatalf("workspace A deny: %+v %v", denied, err)
	}
	other, err := store.Take(ctx, wsB.ID, ClassExecute, 1, 1.0/60.0, now)
	if err != nil || !other.Allowed {
		t.Fatalf("workspace B must be independent: %+v %v", other, err)
	}
	again, err := store.Take(ctx, wsA.ID, ClassExecute, 1, 1.0/60.0, now.Add(time.Minute))
	if err != nil || !again.Allowed {
		t.Fatalf("workspace A refill: %+v %v", again, err)
	}

	allowed, _, err := store.Allow(ctx, "login:ip:203.0.113.10", 1, time.Minute, now)
	if err != nil || !allowed {
		t.Fatalf("login window allow: %v %v", allowed, err)
	}
	allowed, retry, err := store.Allow(ctx, "login:ip:203.0.113.10", 1, time.Minute, now)
	if err != nil || allowed || retry < time.Second {
		t.Fatalf("login window deny: allowed=%v retry=%s err=%v", allowed, retry, err)
	}
	embedOK, _, err := store.Allow(ctx, "ip:203.0.113.10", 1, time.Minute, now)
	if err != nil || !embedOK {
		t.Fatalf("embed key must not share the login window: %v %v", embedOK, err)
	}
	var stored string
	if err := app.QueryRow(ctx, `SELECT key_hash FROM auth_rate_windows WHERE key_hash = $1`, KeyHash("login:ip:203.0.113.10")).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var leaked int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM auth_rate_windows WHERE key_hash LIKE '%203.0.113%'`).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatal("auth window stored a client address")
	}
}
