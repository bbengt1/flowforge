package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// The park's approver-status read is only safe against an instance-wide
// disable under READ COMMITTED (a fresh snapshot per statement after the
// workspace share lock). LockWorkspaceForPark fails closed otherwise.
func TestPostgresParkLockNeedsReadCommitted(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := NewPostgres(pool)
	suffix := newID()[:8]
	tenant, err := store.CreateTenant(ctx, "tp-"+suffix, "Tenant "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := store.UpsertUser(ctx, "https://idp.example", "park-"+suffix, "Owner")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(ctx, tenant.ID, "park-"+suffix, "Park", owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		level pgx.TxIsoLevel
		want  error
	}{
		{pgx.ReadCommitted, nil},
		{pgx.RepeatableRead, parkedapproval.ErrNotReadCommitted},
		{pgx.Serializable, parkedapproval.ErrNotReadCommitted},
	} {
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: c.level})
		if err != nil {
			t.Fatal(err)
		}
		got := parkedapproval.LockWorkspaceForPark(ctx, tx, ws.ID)
		_ = tx.Rollback(ctx)
		if !errors.Is(got, c.want) {
			t.Fatalf("%s: err = %v, want %v", c.level, got, c.want)
		}
	}
	// The default transaction (what BeginScoped uses) is READ COMMITTED.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := parkedapproval.LockWorkspaceForPark(ctx, tx, ws.ID); err != nil {
		t.Fatalf("default isolation: %v", err)
	}
}
