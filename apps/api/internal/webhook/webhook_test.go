package webhook

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestSignAndVerifyRawBody(t *testing.T) {
	secret := []byte("super-secret-hook")
	body := []byte(`{"env":"prod"}`)
	ts := "1700000000"
	sig := SignV1(secret, ts, body)
	if err := VerifySignature(secret, ts, body, sig); err != nil {
		t.Fatal(err)
	}
	if err := VerifySignature(secret, ts, []byte(`{"env":"staging"}`), sig); err != ErrBadSignature {
		t.Fatalf("mutated body: %v", err)
	}
	if err := VerifySignature([]byte("other-secret"), ts, body, sig); err != ErrBadSignature {
		t.Fatalf("wrong secret: %v", err)
	}
	if _, _, err := ParseSignature(""); err != ErrBadSignature {
		t.Fatalf("empty: %v", err)
	}
}

func TestTimestampSkew(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	if _, err := CheckTimestamp("1700000000", now, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckTimestamp("1699990000", now, 5*time.Minute); err != ErrTimestampSkew {
		t.Fatalf("old: %v", err)
	}
	if _, err := CheckTimestamp("not-a-time", now, 5*time.Minute); err != ErrTimestampSkew {
		t.Fatalf("bad: %v", err)
	}
}

func TestMapFieldsAllowlist(t *testing.T) {
	payload := map[string]any{"issue": map[string]any{"id": "42", "secret": "nope"}, "env": "prod"}
	mapped, err := MapFields(payload, map[string]string{"ticket": "issue.id", "env": "env"})
	if err != nil {
		t.Fatal(err)
	}
	if mapped["ticket"] != "42" || mapped["env"] != "prod" {
		t.Fatalf("mapped = %#v", mapped)
	}
	if _, ok := mapped["secret"]; ok {
		t.Fatal("unmapped secret leaked")
	}
	if _, err := MapFields(payload, map[string]string{"x": "../etc"}); err != ErrInvalid {
		t.Fatalf("path: %v", err)
	}
}

func TestMemoryReplayRateAndTenancy(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scopeA, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
	if err != nil {
		t.Fatal(err)
	}
	trig, err := store.Create(ctx, scopeA, CreateInput{
		WorkflowID:         "55555555-5555-4555-8555-555555555555",
		WorkflowVersionID:  "66666666-6666-4666-8666-666666666666",
		SecretCredentialID: "77777777-7777-4777-8777-777777777777",
		RateLimitPerMinute: 2,
		MaxConcurrency:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(trig.PublicID, "wh_") || trig.IngressPath != "/api/v1/hooks/"+trig.PublicID {
		t.Fatalf("public id = %+v", trig)
	}
	if _, err := store.Get(ctx, scopeB, trig.ID); err != ErrNotFound {
		t.Fatalf("cross-workspace get: %v", err)
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	limits := DeliveryLimits{
		ReplayID: ReplayID("1700000000", []byte(`{}`)), ReplayRetention: 10 * time.Minute,
		RateLimitPerMinute: 2, WorkspaceRatePerMinute: 10, MaxConcurrency: 1, WorkspaceMaxConcurrency: 2,
	}
	if err := store.AcquireDelivery(ctx, scopeA, trig.ID, now, limits); err != nil {
		t.Fatal(err)
	}
	if err := store.AcquireDelivery(ctx, scopeA, trig.ID, now, limits); err != ErrReplay {
		t.Fatalf("replay: %v", err)
	}
	limits.ReplayID = ReplayID("1700000001", []byte(`{}`))
	if err := store.AcquireDelivery(ctx, scopeA, trig.ID, now, limits); err != ErrConcurrency {
		t.Fatalf("concurrency: %v", err)
	}
	store.ReleaseDelivery(ctx, scopeA, trig.ID, now)
	limits.RateLimitPerMinute = 1
	if err := store.AcquireDelivery(ctx, scopeA, trig.ID, now, limits); err != ErrRateLimited {
		t.Fatalf("rate: %v", err)
	}
}

func TestSecretFromCanonicalNeverNeedsRawMap(t *testing.T) {
	secret, err := SecretFromCanonical([]byte(`{"secret":"hook-secret-value"}`))
	if err != nil || secret != "hook-secret-value" {
		t.Fatalf("%q %v", secret, err)
	}
	if _, err := SecretFromCanonical([]byte(`{"token":"nope"}`)); err != ErrBadSignature {
		t.Fatalf("missing: %v", err)
	}
}
