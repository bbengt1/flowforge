package embed

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPostgresJTIConsumeIsSingleStatement(t *testing.T) {
	db := &recordingJTIDB{row: "cccccccc-cccc-4ccc-8ccc-cccccccccc01"}
	store := NewPostgresJTI(db)
	exp := time.Now().UTC().Add(time.Minute)
	if err := store.Consume(context.Background(), db.row, exp); err != nil {
		t.Fatal(err)
	}
	if db.execs != 0 {
		t.Fatalf("Consume must not Exec (no DELETE): execs=%d sql=%q", db.execs, strings.Join(db.execSQL, " | "))
	}
	if db.queries != 1 {
		t.Fatalf("Consume must be one QueryRow, got %d", db.queries)
	}
	sql := db.querySQL[0]
	if !strings.Contains(sql, "INSERT INTO embed_assertion_jtis") ||
		!strings.Contains(sql, "ON CONFLICT (jti) DO NOTHING") ||
		!strings.Contains(sql, "RETURNING jti") {
		t.Fatalf("expected single INSERT ON CONFLICT RETURNING, got %s", sql)
	}
	if strings.Contains(strings.ToUpper(sql), "DELETE") {
		t.Fatalf("consume SQL must not delete: %s", sql)
	}

	db.row = ""
	db.err = pgx.ErrNoRows
	if err := store.Consume(context.Background(), "cccccccc-cccc-4ccc-8ccc-cccccccccc01", exp); err != ErrReplay {
		t.Fatalf("conflict RETURNING: %v", err)
	}
	if db.queries != 2 || db.execs != 0 {
		t.Fatalf("replay must stay one statement: queries=%d execs=%d", db.queries, db.execs)
	}
}

func TestPostgresJTIPurgeUsesRetainUntil(t *testing.T) {
	db := &recordingJTIDB{}
	store := NewPostgresJTI(db)
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	n, err := store.PurgeExpired(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 || db.execs != 1 {
		t.Fatalf("purge n=%d execs=%d", n, db.execs)
	}
	sql := db.execSQL[0]
	if !strings.Contains(sql, "retain_until") || strings.Contains(sql, "expires_at") {
		t.Fatalf("purge must key off retain_until, not expires_at: %s", sql)
	}
}

func TestPostgresJTIFailClosed(t *testing.T) {
	if err := NewPostgresJTI(nil).Consume(context.Background(), "cccccccc-cccc-4ccc-8ccc-cccccccccc01", time.Now()); err != ErrStoreUnavailable {
		t.Fatalf("nil db: %v", err)
	}
	var store *PostgresJTI
	if err := store.Consume(context.Background(), "cccccccc-cccc-4ccc-8ccc-cccccccccc01", time.Now()); err != ErrStoreUnavailable {
		t.Fatalf("nil store: %v", err)
	}
	db := &recordingJTIDB{err: context.DeadlineExceeded}
	if err := NewPostgresJTI(db).Consume(context.Background(), "cccccccc-cccc-4ccc-8ccc-cccccccccc01", time.Now()); err != ErrStoreUnavailable {
		t.Fatalf("store error: %v", err)
	}
}

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
	if _, err := pool.Exec(ctx, `DELETE FROM embed_assertion_jtis WHERE jti = $1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	if err := store.Consume(ctx, id, exp); err != nil {
		t.Fatal(err)
	}
	if err := store.Consume(ctx, id, exp); err != ErrReplay {
		t.Fatalf("replay: %v", err)
	}

	afterExp := exp.Add(time.Second)
	n, err := store.PurgeExpired(ctx, afterExp)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("purge at assertion exp must retain used id, purged=%d", n)
	}
	if err := store.Consume(ctx, id, afterExp.Add(time.Minute)); err != ErrReplay {
		t.Fatalf("used jti after exp within retention: %v", err)
	}
	past := exp.Add(JTIRetention)
	n, err = store.PurgeExpired(ctx, past)
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatalf("purge after retain_until: %d", n)
	}
	if err := store.Consume(ctx, id, past.Add(time.Minute)); err != nil {
		t.Fatalf("reuse after retention: %v", err)
	}

	raceID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	if _, err := pool.Exec(ctx, `DELETE FROM embed_assertion_jtis WHERE jti = $1::uuid`, raceID); err != nil {
		t.Fatal(err)
	}
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

type recordingJTIDB struct {
	queries  int
	execs    int
	querySQL []string
	execSQL  []string
	row      string
	err      error
}

func (r *recordingJTIDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	r.execs++
	r.execSQL = append(r.execSQL, sql)
	if r.err != nil {
		return pgconn.CommandTag{}, r.err
	}
	return pgconn.NewCommandTag("DELETE 0"), nil
}

func (r *recordingJTIDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	r.queries++
	r.querySQL = append(r.querySQL, sql)
	if r.err != nil {
		return errScanRow{err: r.err}
	}
	if r.row == "" {
		return errScanRow{err: pgx.ErrNoRows}
	}
	return scanRow{value: r.row}
}

type scanRow struct{ value string }

func (s scanRow) Scan(dest ...any) error {
	if len(dest) == 0 {
		return nil
	}
	if p, ok := dest[0].(*string); ok {
		*p = s.value
	}
	return nil
}

type errScanRow struct{ err error }

func (e errScanRow) Scan(...any) error { return e.err }
