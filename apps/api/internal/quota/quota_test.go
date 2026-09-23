package quota

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestMemoryAllowDenyRefillAndIsolation(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	store := NewMemory()
	ctx := context.Background()
	capacity := 2.0
	refill := 2.0 / 60.0

	first, err := store.Take(ctx, "ws-a", ClassMutate, capacity, refill, now)
	if err != nil || !first.Allowed {
		t.Fatalf("first = %+v %v", first, err)
	}
	second, err := store.Take(ctx, "ws-a", ClassMutate, capacity, refill, now)
	if err != nil || !second.Allowed {
		t.Fatalf("second = %+v %v", second, err)
	}
	denied, err := store.Take(ctx, "ws-a", ClassMutate, capacity, refill, now)
	if err != nil || denied.Allowed {
		t.Fatalf("deny = %+v %v", denied, err)
	}
	if denied.RetryAfter < time.Second {
		t.Fatalf("retry = %s", denied.RetryAfter)
	}
	other, err := store.Take(ctx, "ws-b", ClassMutate, capacity, refill, now)
	if err != nil || !other.Allowed {
		t.Fatalf("other workspace = %+v %v", other, err)
	}
	read, err := store.Take(ctx, "ws-a", ClassRead, capacity, refill, now)
	if err != nil || !read.Allowed {
		t.Fatalf("read bucket must be independent: %+v %v", read, err)
	}
	later, err := store.Take(ctx, "ws-a", ClassMutate, capacity, refill, now.Add(time.Minute))
	if err != nil || !later.Allowed {
		t.Fatalf("refilled = %+v %v", later, err)
	}
	free, err := store.Take(ctx, "ws-a", ClassMutate, -1, refill, now)
	if err != nil || !free.Allowed {
		t.Fatalf("unlimited = %+v %v", free, err)
	}
}

func TestNilMemoryFailsClosed(t *testing.T) {
	var store *Memory
	_, err := store.Take(context.Background(), "ws", ClassMutate, 1, 1, time.Now())
	if err == nil {
		t.Fatal("nil store must fail closed")
	}
}

func TestNormalizeAndLoad(t *testing.T) {
	got := Normalize(Limits{})
	def := DefaultLimits()
	if got != def {
		t.Fatalf("defaults %+v", got)
	}
	got = Normalize(Limits{MutatePerMinute: 4})
	if got.MutatePerMinute != 4 || got.MutateBurst != 4 || got.ReadPerMinute != def.ReadPerMinute {
		t.Fatalf("partial %+v", got)
	}
	got = Normalize(Limits{ExecuteConcurrency: -1, MutatePerMinute: -1, MutateBurst: -1})
	if got.ExecuteConcurrency != -1 || got.MutatePerMinute != -1 {
		t.Fatalf("unlimited %+v", got)
	}
	t.Setenv(EnvMutatePerMinute, "9")
	t.Setenv(EnvExecuteConcurrency, "3")
	loaded := Load()
	if loaded.MutatePerMinute != 9 || loaded.MutateBurst != 9 || loaded.ExecuteConcurrency != 3 {
		t.Fatalf("load %+v", loaded)
	}
	t.Setenv(EnvMutatePerMinute, "nope")
	if Load().MutatePerMinute != def.MutatePerMinute {
		t.Fatal("invalid env must use the default")
	}
}

func TestClassForRouteKeepsAuthDoorsSeparate(t *testing.T) {
	if ClassForRoute("POST", "/api/v1/login") != "" {
		t.Fatal("login must not use the workspace bucket")
	}
	if ClassForRoute("POST", "/api/v1/embed/exchange") != "" || ClassForRoute("POST", "/api/v1/embed/assertions") != "" {
		t.Fatal("embed doors must not use the workspace bucket")
	}
	if ClassForRoute("POST", "/api/v1/machine/token") != "" || ClassForRoute("POST", "/api/v1/hooks/{publicId}") != "" {
		t.Fatal("machine token and webhook ingress stay on their own limits")
	}
	if ClassForRoute("POST", "/api/v1/workflows/validate") != ClassMutate {
		t.Fatal("validate")
	}
	if ClassForRoute("POST", "/api/v1/workflows/normalize") != ClassMutate {
		t.Fatal("normalize")
	}
	if ClassForRoute("POST", "/api/v1/workflows/{workflowId}/publish") != ClassMutate {
		t.Fatal("publish")
	}
	if ClassForRoute("POST", "/api/v1/workflows/{workflowId}/executions") != ClassExecute {
		t.Fatal("execution start")
	}
	if ClassForRoute("POST", "/api/v1/artifacts/{artifactId}/downloads") != ClassDownload {
		t.Fatal("download")
	}
	if ClassForRoute("GET", "/api/v1/workflows") != ClassRead {
		t.Fatal("list")
	}
	if ClassForRoute("GET", "/api/v1/workflows/{workflowId}") != "" {
		t.Fatal("single get is not an expensive list")
	}
	if ClassForRoute("POST", "/api/v1/cluster-targets") != ClassMutate {
		t.Fatal("ops write")
	}
	if ClassForRoute("GET", "/api/v1/session") != "" {
		t.Fatal("session poll is not a list")
	}
}

type errBegin struct{}

func (errBegin) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("db down")
}

func TestPostgresBeginFailsClosed(t *testing.T) {
	store := NewPostgres(errBegin{})
	ctx := context.Background()
	now := time.Now().UTC()
	if _, err := store.Take(ctx, "11111111-1111-4111-8111-111111111111", ClassMutate, 2, 1, now); err == nil {
		t.Fatal("take must fail closed")
	}
	ok, _, err := store.Allow(ctx, "login:ip:203.0.113.8", 5, time.Minute, now)
	if err == nil || ok {
		t.Fatal("auth window must fail closed")
	}
	if stringsContains(err.Error(), "203.0.113.8") || stringsContains(err.Error(), "login:ip") {
		t.Fatalf("error leaked the key: %v", err)
	}
}

func stringsContains(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && (s == sub || len(s) > 0 && contains(s, sub))
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
