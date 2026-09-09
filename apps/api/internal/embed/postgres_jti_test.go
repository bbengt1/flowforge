package embed

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresJTIConsumeReplayAndRace(t *testing.T) {
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

	store := NewPostgresJTI(pool)
	now := time.Now().UTC()
	id := "cccccccc-cccc-4ccc-8ccc-cccccccccc01"
	exp := now.Add(time.Minute)
	if err := store.Consume(ctx, id, exp); err != nil {
		t.Fatal(err)
	}
	if err := store.Consume(ctx, id, exp); err != ErrReplay {
		t.Fatalf("replay: %v", err)
	}

	raceID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- store.Consume(ctx, raceID, now.Add(time.Minute))
		}()
	}
	wg.Wait()
	close(errs)
	var ok, replay int
	for err := range errs {
		switch err {
		case nil:
			ok++
		case ErrReplay:
			replay++
		default:
			t.Fatalf("race: %v", err)
		}
	}
	if ok != 1 || replay != 7 {
		t.Fatalf("ok=%d replay=%d", ok, replay)
	}
}
