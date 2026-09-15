package localauth

import (
	"testing"
	"time"
)

func TestNormalizeLimitsDefaultsAndUnlimited(t *testing.T) {
	got := NormalizeLimits(Limits{})
	if got.Window != DefaultRateWindow || got.PerIP != DefaultIPLimit || got.Identifier != DefaultIdentifierLimit {
		t.Fatalf("zero limits %+v", got)
	}
	custom := NormalizeLimits(Limits{Window: 30 * time.Second, PerIP: 7, Identifier: 4})
	if custom.Window != 30*time.Second || custom.PerIP != 7 || custom.Identifier != 4 {
		t.Fatalf("custom limits %+v", custom)
	}
	unlimited := NormalizeLimits(Limits{PerIP: -1, Identifier: -1})
	if unlimited.PerIP != -1 || unlimited.Identifier != -1 {
		t.Fatalf("negative must stay unlimited: %+v", unlimited)
	}
}

func TestLoadLimitsFromEnv(t *testing.T) {
	t.Setenv(EnvRateLimitIP, "7")
	t.Setenv(EnvRateLimitIdentifier, "4")
	t.Setenv(EnvRateLimitWindow, "30s")
	got := LoadLimits()
	if got.PerIP != 7 || got.Identifier != 4 || got.Window != 30*time.Second {
		t.Fatalf("env limits %+v", got)
	}
}

func TestLoginRateLimitKeys(t *testing.T) {
	if IPKey("192.0.2.10") != "login:ip:192.0.2.10" {
		t.Fatalf("ip key %q", IPKey("192.0.2.10"))
	}
	if IPKey("  ") != "login:ip:unknown" {
		t.Fatalf("empty ip key %q", IPKey("  "))
	}
	if IdentifierKey("admin@example.com") != "login:id:admin@example.com" {
		t.Fatalf("id key %q", IdentifierKey("admin@example.com"))
	}
	if IdentifierKey("") != "login:id:unknown" {
		t.Fatalf("empty id key %q", IdentifierKey(""))
	}
}
