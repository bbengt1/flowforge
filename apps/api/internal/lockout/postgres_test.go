package lockout

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresLockoutSurvivesNewStore(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	users := identity.NewPostgres(pool)
	suffix := time.Now().UTC().Format("150405.000")
	user, err := users.UpsertUser(ctx, "https://idp.example", "lock-"+suffix, "Lock")
	if err != nil {
		t.Fatal(err)
	}
	first := NewPostgres(pool)
	now := time.Now().UTC()
	if _, err := first.NoteFailure(ctx, user.ID, 2, now); err != nil {
		t.Fatal(err)
	}
	if _, err := first.NoteFailure(ctx, user.ID, 2, now); err != nil {
		t.Fatal(err)
	}
	second := NewPostgres(pool)
	st, err := second.Get(ctx, user.ID)
	if err != nil || !st.Locked() || st.Failed != 2 {
		t.Fatalf("new store: %+v %v", st, err)
	}
	if err := second.Unlock(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	st, err = first.Get(ctx, user.ID)
	if err != nil || st.Locked() || st.Failed != 0 {
		t.Fatalf("unlocked: %+v %v", st, err)
	}
}
