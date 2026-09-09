package embed

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestMemoryJTIConsumeRaceAndReplay(t *testing.T) {
	jti := NewMemoryJTI()
	id := "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	exp := time.Now().UTC().Add(time.Minute)
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- jti.Consume(context.Background(), id, exp)
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
			t.Fatalf("unexpected %v", err)
		}
	}
	if ok != 1 || replay != 7 {
		t.Fatalf("ok=%d replay=%d", ok, replay)
	}
	if err := jti.Consume(context.Background(), id, exp); err != ErrReplay {
		t.Fatalf("second consume: %v", err)
	}
}

func TestMemoryJTIRetainPastExpiryAndPurge(t *testing.T) {
	store := NewMemoryJTI()
	id := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	exp := now.Add(time.Minute)
	if err := store.Consume(context.Background(), id, exp); err != nil {
		t.Fatal(err)
	}
	afterExp := exp.Add(time.Second)
	if err := store.Consume(context.Background(), id, afterExp.Add(time.Minute)); err != ErrReplay {
		t.Fatalf("used jti after assertion exp must stay reserved: %v", err)
	}
	n, err := store.PurgeExpired(context.Background(), afterExp)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("purge at exp must retain used ids, purged=%d", n)
	}
	if err := store.Consume(context.Background(), id, afterExp.Add(time.Minute)); err != ErrReplay {
		t.Fatalf("still reserved within retention: %v", err)
	}
	within := exp.Add(JTIRetention - time.Second)
	n, err = store.PurgeExpired(context.Background(), within)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("purge inside retention window purged=%d", n)
	}
	past := exp.Add(JTIRetention)
	n, err = store.PurgeExpired(context.Background(), past)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purge after retain_until: %d", n)
	}
	if err := store.Consume(context.Background(), id, past.Add(time.Minute)); err != nil {
		t.Fatalf("reuse after retention: %v", err)
	}
}

func TestMemoryJTIFailClosed(t *testing.T) {
	var store *MemoryJTI
	if err := store.Consume(context.Background(), "cccccccc-cccc-4ccc-8ccc-cccccccccccc", time.Now()); err != ErrStoreUnavailable {
		t.Fatalf("nil store: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := NewMemoryJTI().Consume(ctx, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", time.Now()); err != ErrStoreUnavailable {
		t.Fatalf("canceled ctx: %v", err)
	}
	if _, err := store.PurgeExpired(context.Background(), time.Now()); err != ErrStoreUnavailable {
		t.Fatalf("nil purge: %v", err)
	}
}

func TestJTIRetainUntilIsExpPlusWindow(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	exp := now.Add(2 * time.Minute)
	got := jtiRetainUntil(exp, now)
	want := exp.Add(JTIRetention)
	if !got.Equal(want) {
		t.Fatalf("retain_until=%s want %s", got, want)
	}
	if JTIRetention != 24*time.Hour {
		t.Fatalf("documented retention is 24h, got %s", JTIRetention)
	}
}
