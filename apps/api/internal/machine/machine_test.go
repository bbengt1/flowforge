package machine

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestNormalizeGrantsDenyByDefault(t *testing.T) {
	got, err := NormalizeGrants(nil, false)
	if err != nil || len(got) != 0 {
		t.Fatalf("empty grants = %v %v", got, err)
	}
	if authz.Allows(got, authz.PermOpsMetricsRead) || authz.Allows(got, authz.PermPlatformAdminister) || authz.Allows(got, authz.PermWorkflowExecute) {
		t.Fatal("empty grants must deny")
	}
	if _, err := NormalizeGrants([]string{authz.PermEmbedImpersonate}, false); !errors.Is(err, ErrInvalid) {
		t.Fatalf("embed.impersonate: %v", err)
	}
	if _, err := NormalizeGrants([]string{"not.a.permission"}, false); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown: %v", err)
	}
	if _, err := NormalizeGrants([]string{authz.PermWorkflowExecute}, false); !errors.Is(err, ErrBinding) {
		t.Fatalf("unbound execute: %v", err)
	}
	metrics, err := NormalizeGrants([]string{authz.PermOpsMetricsRead}, false)
	if err != nil || !authz.Allows(metrics, authz.PermOpsMetricsRead) || authz.Allows(metrics, authz.PermPlatformAdminister) {
		t.Fatalf("metrics grant = %v %v", metrics, err)
	}
	admin, err := NormalizeGrants([]string{authz.PermPlatformAdminister}, false)
	if err != nil || !authz.Allows(admin, authz.PermPlatformAdminister) {
		t.Fatalf("explicit platform grant = %v %v", admin, err)
	}
}

func TestViewOmitsSecretMaterial(t *testing.T) {
	secret := "machine-secret-value-1"
	hash, err := HashSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p, err := normalizeInput(Input{
		UserID:      "11111111-1111-4111-8111-111111111111",
		ClientID:    "Prom-Scrape",
		DisplayName: "Prometheus",
		SecretHash:  hash,
		PublicKey:   pub,
		Now:         time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(p.View())
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, leak := range []string{secret, hash, "$2a$", "$2b$"} {
		if strings.Contains(text, leak) {
			t.Fatalf("view echoed %q: %s", leak, text)
		}
	}
	if strings.Contains(text, "secret") || strings.Contains(text, "public_key") || strings.Contains(text, "assertion") {
		t.Fatalf("view has secret fields: %s", text)
	}
	if !strings.Contains(text, `"client_id":"prom-scrape"`) || !strings.Contains(text, `"display_name":"Prometheus"`) {
		t.Fatalf("view = %s", text)
	}
}

func TestMemoryRotateAndRevoke(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	oldSecret := "machine-secret-value-1"
	newSecret := "machine-secret-value-2"
	oldHash, err := HashSecret(oldSecret)
	if err != nil {
		t.Fatal(err)
	}
	newHash, err := HashSecret(newSecret)
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(ctx, Input{
		UserID:       "22222222-2222-4222-8222-222222222222",
		ClientID:     "sched-bot",
		DisplayName:  "Scheduler",
		SecretHash:   oldHash,
		Grants:       []string{authz.PermWorkflowExecute},
		TenantID:     "33333333-3333-4333-8333-333333333333",
		WorkspaceID:  "44444444-4444-4444-8444-444444444444",
		WorkbenchKey: "ops",
		Now:          time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := Authenticate(created, oldSecret, "", time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	rotated, err := store.Rotate(ctx, created.ID, Rotation{SecretHash: newHash, Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if err := Authenticate(rotated, oldSecret, "", time.Now(), nil); !errors.Is(err, ErrCredential) {
		t.Fatalf("old secret: %v", err)
	}
	if err := Authenticate(rotated, newSecret, "", time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	revoked, err := store.Revoke(ctx, created.ID, time.Now().UTC())
	if err != nil || revoked.Status != StatusRevoked {
		t.Fatalf("revoke: %+v %v", revoked.View(), err)
	}
	if err := Authenticate(revoked, newSecret, "", time.Now(), nil); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked auth: %v", err)
	}
	if _, err := store.Rotate(ctx, created.ID, Rotation{SecretHash: newHash}); !errors.Is(err, ErrRevoked) {
		t.Fatalf("rotate revoked: %v", err)
	}
	body, _ := json.Marshal(revoked.View())
	if strings.Contains(string(body), newSecret) || strings.Contains(string(body), oldSecret) {
		t.Fatalf("revoked view leaked secret: %s", body)
	}
}

func TestAssertionRoundTripAndReplay(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	token, err := SignAssertion(priv, "prom-scrape", now, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(token, "BEGIN") {
		t.Fatal("assertion included a key")
	}
	store := NewMemory()
	p, err := store.Create(context.Background(), Input{
		UserID:      "55555555-5555-4555-8555-555555555555",
		ClientID:    "prom-scrape",
		DisplayName: "Prometheus",
		PublicKey:   pub,
		Grants:      []string{authz.PermOpsMetricsRead},
		Now:         now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := Authenticate(p, "", token, now, func(jti string, until time.Time) error {
		return store.ConsumeJTI(context.Background(), jti, p.ClientID, until, now)
	}); err != nil {
		t.Fatal(err)
	}
	if err := Authenticate(p, "", token, now, func(jti string, until time.Time) error {
		return store.ConsumeJTI(context.Background(), jti, p.ClientID, until, now)
	}); !errors.Is(err, ErrReplay) {
		t.Fatalf("replay: %v", err)
	}
	other, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p.publicKey = other
	if err := Authenticate(p, "", token, now.Add(time.Second), func(string, time.Time) error { return nil }); !errors.Is(err, ErrCredential) {
		t.Fatalf("wrong key: %v", err)
	}
}

func TestCheckConsumerFailClosed(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	secret := "not-in-the-error"
	if _, err := ParseConsumers("metrics,scheduler,automation", "", "sched-bot", "auto-bot"); err == nil {
		t.Fatal("missing metrics client id must fail closed")
	} else if strings.Contains(err.Error(), secret) {
		t.Fatal(err)
	}
	if _, err := ParseConsumers("metrics,nope", "prom-scrape", "", ""); err == nil {
		t.Fatal("unknown consumer must fail closed")
	}
	cfg, err := ParseConsumers("metrics,scheduler,automation", "prom-scrape", "sched-bot", "auto-bot")
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckConsumer(ctx, store, cfg, ConsumerMetrics); err == nil {
		t.Fatal("missing principal must fail closed")
	}
	hash := "$2a$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcd"
	if _, err := store.Create(ctx, Input{
		UserID:      "66666666-6666-4666-8666-666666666666",
		ClientID:    "prom-scrape",
		DisplayName: "Prometheus",
		SecretHash:  hash,
		Now:         time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := CheckConsumer(ctx, store, cfg, ConsumerMetrics); err == nil {
		t.Fatal("principal without ops.metrics.read must fail closed")
	}
	if _, err := store.Create(ctx, Input{
		UserID:       "77777777-7777-4777-8777-777777777777",
		ClientID:     "sched-bot",
		DisplayName:  "Scheduler",
		SecretHash:   hash,
		Grants:       []string{authz.PermWorkflowExecute},
		TenantID:     "33333333-3333-4333-8333-333333333333",
		WorkspaceID:  "44444444-4444-4444-8444-444444444444",
		WorkbenchKey: "ops",
		Now:          time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := CheckConsumer(ctx, store, cfg, ConsumerScheduler); err != nil {
		t.Fatal(err)
	}
	called := false
	if err := Gate(ctx, store, cfg, ConsumerMetrics, func(context.Context) error {
		called = true
		return nil
	}); err == nil || called {
		t.Fatal("misconfigured metrics consumer must not run")
	}
	if _, err := store.Revoke(ctx, mustID(t, store, "sched-bot"), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := CheckConsumer(ctx, store, cfg, ConsumerScheduler); err == nil {
		t.Fatal("revoked scheduler principal must fail closed")
	}
	empty, err := ParseConsumers("", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckConsumer(ctx, nil, empty, ConsumerMetrics); err != nil {
		t.Fatal(err)
	}
}

func mustID(t *testing.T, store *Memory, clientID string) string {
	t.Helper()
	p, err := store.GetByClientID(context.Background(), clientID)
	if err != nil {
		t.Fatal(err)
	}
	return p.ID
}
