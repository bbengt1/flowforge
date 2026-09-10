package embed

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestOverlapStillValidRefusesMissingAndFarFuture(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	if OverlapStillValid(time.Time{}, now) {
		t.Fatal("zero overlapUntil must not be treated as forever")
	}
	if OverlapStillValid(now, now) {
		t.Fatal("inclusive end must be expired")
	}
	if OverlapStillValid(now.Add(-time.Second), now) {
		t.Fatal("past overlapUntil must be expired")
	}
	if !OverlapStillValid(now.Add(2*time.Minute), now) {
		t.Fatal("short overlapUntil must be valid")
	}
	if !OverlapStillValid(now.Add(MaxOverlapTTL), now) {
		t.Fatal("max overlapUntil must be valid")
	}
	if OverlapStillValid(now.Add(MaxOverlapTTL+time.Second), now) {
		t.Fatal("far-future overlapUntil must be refused")
	}
}

func TestValidateOverlapUntilRejectsMissingZeroAndTooLong(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	if err := ValidateOverlapUntil(time.Time{}, now); !errors.Is(err, ErrOverlapUntilRequired) {
		t.Fatalf("missing: %v", err)
	}
	if err := ValidateOverlapUntil(now, now); !errors.Is(err, ErrOverlapUntilRequired) {
		t.Fatalf("zero duration: %v", err)
	}
	if err := ValidateOverlapUntil(now.Add(-time.Second), now); !errors.Is(err, ErrOverlapUntilRequired) {
		t.Fatalf("past: %v", err)
	}
	if err := ValidateOverlapUntil(now.Add(MaxOverlapTTL+time.Hour), now); !errors.Is(err, ErrOverlapUntilTooLong) {
		t.Fatalf("too long: %v", err)
	}
	if err := ValidateOverlapUntil(now.Add(2*time.Minute), now); err != nil {
		t.Fatalf("short: %v", err)
	}
	if err := ValidateOverlapUntil(now.Add(MaxOverlapTTL), now); err != nil {
		t.Fatalf("max: %v", err)
	}
}

func TestParseOverlapKeysRequiresShortOverlapUntil(t *testing.T) {
	now := time.Now().UTC()
	old := TestMaterial()
	jwk := map[string]any{
		"kty": KeyType, "crv": Curve, "x": encodePublicX(old.Public),
		"kid": "env-old", "use": "sig", "alg": Algorithm,
	}
	missing, err := json.Marshal([]map[string]any{jwk})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseOverlapKeys(string(missing)); !errors.Is(err, ErrOverlapUntilRequired) {
		t.Fatalf("missing overlapUntil: %v", err)
	}

	jwk["overlapUntil"] = now.Add(48 * time.Hour).Format(time.RFC3339)
	tooLong, err := json.Marshal([]map[string]any{jwk})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseOverlapKeys(string(tooLong)); !errors.Is(err, ErrOverlapUntilTooLong) {
		t.Fatalf("too-long overlapUntil: %v", err)
	}

	jwk["overlapUntil"] = now.Add(30 * time.Minute).Format(time.RFC3339)
	okRaw, err := json.Marshal(map[string]any{"keys": []map[string]any{jwk}})
	if err != nil {
		t.Fatal(err)
	}
	keys, err := parseOverlapKeys(string(okRaw))
	if err != nil {
		t.Fatalf("valid short overlapUntil: %v", err)
	}
	if len(keys) != 1 || keys[0].Kid != "env-old" || keys[0].OverlapUntil.IsZero() {
		t.Fatalf("keys %+v", keys)
	}
}

func TestAddOverlapRequiresShortOverlapUntil(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := TestMaterial()
	ring := NewRing(old, NewMemoryKeys())
	active := old.PublicJWKS().Keys[0]

	if err := ring.AddOverlap(ctx, active, time.Time{}, now); !errors.Is(err, ErrOverlapUntilRequired) {
		t.Fatalf("missing: %v", err)
	}
	if err := ring.AddOverlap(ctx, active, now.Add(48*time.Hour), now); !errors.Is(err, ErrOverlapUntilTooLong) {
		t.Fatalf("too long: %v", err)
	}
	until := now.Add(15 * time.Minute)
	if err := ring.AddOverlap(ctx, active, until, now); err != nil {
		t.Fatalf("short: %v", err)
	}
	next := NewEphemeralMaterial()
	next.KeyID = "after-short-overlap"
	if err := ring.InstallActive(next); err != nil {
		t.Fatal(err)
	}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	opt := VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	}
	if _, err := ring.Verify(ctx, minted.Assertion, opt); err != nil {
		t.Fatalf("valid short overlap: %v", err)
	}
}

func TestLoadMaterialBootFailsOnBadOverlapEnv(t *testing.T) {
	old := TestMaterial()
	t.Setenv(EnvSigningKey, EncodePKCS8PEM(old.Private))
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(EnvSigningKeyID, "stable:ops")
	t.Setenv("APP_ENV", "production")
	jwk := map[string]any{
		"kty": KeyType, "crv": Curve, "x": encodePublicX(old.Public),
		"kid": "env-bad", "use": "sig", "alg": Algorithm,
	}
	raw, err := json.Marshal([]map[string]any{jwk})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvOverlapKeys, string(raw))
	if _, err := LoadMaterial(); !errors.Is(err, ErrOverlapUntilRequired) {
		t.Fatalf("boot-fail missing overlapUntil: %v", err)
	}
}
