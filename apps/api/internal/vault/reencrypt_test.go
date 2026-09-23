package vault

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestReencryptAllRewrapsUnderRLSScope(t *testing.T) {
	oldKey := TestKeys()
	next := make([]byte, 32)
	for i := range next {
		next[i] = byte(80 + i)
	}
	plain := []byte("super-secret-plaintext-xyz-rewrap")
	env, err := Encrypt(oldKey, plain)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := Encrypt(Keys{KEK: next, ID: "kms:aws:already1"}, plain)
	if err != nil {
		t.Fatal(err)
	}
	wsOld := "00000000-0000-4000-8000-0000000000a1"
	wsDone := "00000000-0000-4000-8000-0000000000a2"
	db := &fakeDB{
		workspaces: []string{wsOld, wsDone},
		creds: map[string][]fakeRow{
			wsOld:  {{id: "00000000-0000-4000-8000-0000000000c1", env: env}},
			wsDone: {{id: "00000000-0000-4000-8000-0000000000c2", env: fresh}},
		},
		arts: map[string][]fakeRow{
			wsOld: {{id: "00000000-0000-4000-8000-0000000000d1", env: env}},
		},
	}
	active := Keys{KEK: next, ID: "kms:aws:already1", Previous: oldKey.KEK, PreviousID: oldKey.ID}
	stats, err := ReencryptAll(context.Background(), db, active)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Workspaces != 1 || stats.Credentials != 1 || stats.Artifacts != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	row := db.creds[wsOld][0]
	if row.env.KeyRef != active.ID {
		t.Fatalf("key ref = %s", row.env.KeyRef)
	}
	if bytes.Contains(row.env.DEKEnvelope, plain) || bytes.Contains(row.env.DEKEnvelope, next) {
		t.Fatal("rewrapped DEK leaked material")
	}
	got, err := Decrypt(Keys{KEK: next, ID: active.ID}, row.env)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatal("decrypt after online reencrypt")
	}
	if db.creds[wsDone][0].env.KeyRef != fresh.KeyRef {
		t.Fatal("current-key row was rewritten")
	}
	if _, err := ReencryptAll(context.Background(), db, Keys{}); err != ErrKeyUnavailable {
		t.Fatalf("empty keys = %v", err)
	}
}

type fakeRow struct {
	id  string
	env Envelope
}

type fakeDB struct {
	workspaces []string
	creds      map[string][]fakeRow
	arts       map[string][]fakeRow
}

func (f *fakeDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if !bytes.Contains([]byte(sql), []byte("FROM workspaces")) {
		return nil, errors.New("unscoped query")
	}
	data := make([][]any, len(f.workspaces))
	for i, id := range f.workspaces {
		data[i] = []any{id}
	}
	return &fakeRows{data: data}, nil
}

func (f *fakeDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeRowErr{err: errors.New("not used")}
}

func (f *fakeDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("not used")
}

func (f *fakeDB) Begin(context.Context) (pgx.Tx, error) {
	return &fakeTx{db: f}, nil
}

type fakeTx struct {
	db *fakeDB
	ws string
}

func (t *fakeTx) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("nested")
}
func (t *fakeTx) Commit(context.Context) error   { return nil }
func (t *fakeTx) Rollback(context.Context) error { return nil }
func (t *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("not used")
}
func (t *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (t *fakeTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (t *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("not used")
}
func (t *fakeTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeRowErr{err: errors.New("not used")}
}
func (t *fakeTx) Conn() *pgx.Conn { return nil }

func (t *fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if bytes.Contains([]byte(sql), []byte("set_workspace_id")) {
		t.ws = args[0].(string)
		return pgconn.NewCommandTag("SELECT 1"), nil
	}
	if t.ws == "" {
		return pgconn.CommandTag{}, errors.New("scope missing")
	}
	id := args[0].(string)
	dek := args[1].([]byte)
	ref := args[2].(string)
	ver := args[3].(int)
	var rows []fakeRow
	switch {
	case bytes.Contains([]byte(sql), []byte("UPDATE credentials")):
		rows = t.db.creds[t.ws]
	case bytes.Contains([]byte(sql), []byte("UPDATE execution_artifacts")):
		rows = t.db.arts[t.ws]
	default:
		return pgconn.CommandTag{}, errors.New("unexpected update")
	}
	for i := range rows {
		if rows[i].id == id {
			rows[i].env.DEKEnvelope = append([]byte(nil), dek...)
			rows[i].env.KeyRef = ref
			rows[i].env.Version = ver
			return pgconn.NewCommandTag("UPDATE 1"), nil
		}
	}
	return pgconn.CommandTag{}, errors.New("missing row")
}

func (t *fakeTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if t.ws == "" {
		return nil, errors.New("scope missing")
	}
	ref := args[0].(string)
	var rows []fakeRow
	switch {
	case bytes.Contains([]byte(sql), []byte("FROM credentials")):
		rows = t.db.creds[t.ws]
	case bytes.Contains([]byte(sql), []byte("FROM execution_artifacts")):
		rows = t.db.arts[t.ws]
	default:
		return nil, errors.New("unexpected query")
	}
	var data [][]any
	for _, row := range rows {
		if row.env.KeyRef == ref {
			continue
		}
		data = append(data, []any{row.id, append([]byte(nil), row.env.DEKEnvelope...), row.env.KeyRef, row.env.Version})
	}
	return &fakeRows{data: data}, nil
}

type fakeRows struct {
	data [][]any
	i    int
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Values() ([]any, error)                       { return nil, errors.New("not used") }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }
func (r *fakeRows) Next() bool {
	if r.i >= len(r.data) {
		return false
	}
	r.i++
	return true
}
func (r *fakeRows) Scan(dest ...any) error {
	row := r.data[r.i-1]
	for i, d := range dest {
		switch p := d.(type) {
		case *string:
			*p = row[i].(string)
		case *[]byte:
			*p = append([]byte(nil), row[i].([]byte)...)
		case *int:
			*p = row[i].(int)
		default:
			return errors.New("unsupported scan")
		}
	}
	return nil
}

type fakeRowErr struct{ err error }

func (e fakeRowErr) Scan(...any) error { return e.err }
