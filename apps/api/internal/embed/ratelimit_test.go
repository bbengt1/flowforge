package embed

import (
	"context"
	"errors"
	"testing"
	"time"
)

type failWindow struct{}

func (failWindow) Allow(context.Context, string, int, time.Duration, time.Time) (bool, time.Duration, error) {
	return false, 0, errors.New("db down")
}

func TestLimiterAllowsUnderCapAndDeniesBurst(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	lim := NewLimiter(Limits{Window: time.Minute, ExchangeIP: 2, ExchangePrincipal: 2})
	key := IPKey("203.0.113.9")
	if !lim.Allow(key, lim.Limits().ExchangeIP, now) {
		t.Fatal("first allow")
	}
	if !lim.Allow(key, lim.Limits().ExchangeIP, now) {
		t.Fatal("second allow")
	}
	if lim.Allow(key, lim.Limits().ExchangeIP, now) {
		t.Fatal("third must deny")
	}
	if !lim.Allow(key, lim.Limits().ExchangeIP, now.Add(time.Minute)) {
		t.Fatal("next window must allow")
	}
}

func TestLimiterPrincipalIndependentOfIP(t *testing.T) {
	now := time.Now().UTC()
	lim := NewLimiter(Limits{Window: time.Minute, ExchangeIP: 100, ExchangePrincipal: 1})
	a := PrincipalKey("https://idp.example", "user-a")
	b := PrincipalKey("https://idp.example", "user-b")
	if !lim.Allow(a, 1, now) || lim.Allow(a, 1, now) {
		t.Fatal("subject A burst")
	}
	if !lim.Allow(b, 1, now) {
		t.Fatal("subject B must be independent")
	}
}

func TestSharedBackendFailClosed(t *testing.T) {
	lim := NewLimiter(Limits{Window: time.Minute, ExchangeIP: 10})
	if lim.Shared() {
		t.Fatal("in-process limiter is not shared")
	}
	lim.UseShared(failWindow{})
	if !lim.Shared() {
		t.Fatal("attached backend must be shared")
	}
	ok, _, err := lim.Decide(context.Background(), IPKey("203.0.113.4"), 10, time.Now())
	if err == nil || ok {
		t.Fatal("store failure must fail closed")
	}
	if lim.Allow(IPKey("203.0.113.4"), 10, time.Now()) {
		t.Fatal("Allow must deny when the store fails")
	}
}

func TestNilLimiterFailsClosed(t *testing.T) {
	var lim *Limiter
	if lim.Allow(IPKey("10.0.0.1"), 10, time.Now()) {
		t.Fatal("nil limiter must deny")
	}
}

func TestNegativeLimitIsUnlimited(t *testing.T) {
	now := time.Now().UTC()
	lim := NewLimiter(Limits{Window: time.Minute, ExchangeIP: -1})
	key := IPKey("10.0.0.1")
	for i := 0; i < 200; i++ {
		if !lim.Allow(key, lim.Limits().ExchangeIP, now) {
			t.Fatalf("unlimited denied at %d", i)
		}
	}
}

func TestNormalizeLimitsDefaults(t *testing.T) {
	got := NormalizeLimits(Limits{})
	if got.ExchangeIP != DefaultExchangeIPLimit || got.ExchangePrincipal != DefaultExchangePrincipalLimit {
		t.Fatalf("defaults %+v", got)
	}
	if got.MintPrincipal != DefaultMintPrincipalLimit || got.Window != DefaultRateWindow {
		t.Fatalf("defaults %+v", got)
	}
	got = NormalizeLimits(Limits{ExchangeIP: 3, Window: 2 * time.Second})
	if got.ExchangeIP != 3 || got.Window != 2*time.Second || got.ExchangePrincipal != DefaultExchangePrincipalLimit {
		t.Fatalf("partial %+v", got)
	}
}

func TestPrincipalKeyEmpty(t *testing.T) {
	if PrincipalKey("", "") != "" {
		t.Fatal("empty principal should not mint a key")
	}
	if IPKey("") != "ip:unknown" {
		t.Fatal("empty IP still keyed")
	}
}
