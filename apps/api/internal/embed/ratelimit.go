package embed

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// WindowCounter is a shared fixed-window backend. The API attaches a
// PostgreSQL counter when a database is configured so replica count does
// not multiply the budget. Store errors fail closed. A nil backend keeps
// the in-process window (one process and unit tests).
type WindowCounter interface {
	Allow(ctx context.Context, key string, limit int, window time.Duration, now time.Time) (allowed bool, retryAfter time.Duration, err error)
}

// Documented defaults (ADV-012). Sized so a Portal host remounting
// many iframes from one egress IP stays under the cap; a single
// issuer|subject still cannot brute-force exchange.
const (
	DefaultRateWindow             = time.Minute
	DefaultExchangeIPLimit        = 120
	DefaultExchangePrincipalLimit = 30
	DefaultMintPrincipalLimit     = 60
)

// Limits are per-process embed rate limits. Zero fields become defaults.
// A negative limit is unlimited (ops/test escape hatch).
type Limits struct {
	Window            time.Duration
	ExchangeIP        int
	ExchangePrincipal int
	MintPrincipal     int
}

// DefaultLimits returns documented ADV-012 defaults.
func DefaultLimits() Limits {
	return Limits{
		Window:            DefaultRateWindow,
		ExchangeIP:        DefaultExchangeIPLimit,
		ExchangePrincipal: DefaultExchangePrincipalLimit,
		MintPrincipal:     DefaultMintPrincipalLimit,
	}
}

// NormalizeLimits fills zero fields with defaults. Negative limits stay
// negative (unlimited). Window <= 0 becomes DefaultRateWindow.
func NormalizeLimits(in Limits) Limits {
	out := DefaultLimits()
	if in.Window > 0 {
		out.Window = in.Window
	}
	if in.ExchangeIP != 0 {
		out.ExchangeIP = in.ExchangeIP
	}
	if in.ExchangePrincipal != 0 {
		out.ExchangePrincipal = in.ExchangePrincipal
	}
	if in.MintPrincipal != 0 {
		out.MintPrincipal = in.MintPrincipal
	}
	return out
}

// LoadLimits reads EMBED_* rate-limit env vars. Invalid or empty values
// use documented defaults. A set value of 0 is treated as default (do
// not fail closed on a typo of "0"); use a negative number for unlimited.
func LoadLimits() Limits {
	return NormalizeLimits(Limits{
		Window:            durationEnv(EnvRateLimitWindow, 0),
		ExchangeIP:        intEnv(EnvExchangeRateLimitIP, 0),
		ExchangePrincipal: intEnv(EnvExchangeRateLimitPrincipal, 0),
		MintPrincipal:     intEnv(EnvMintRateLimitPrincipal, 0),
	})
}

func intEnv(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

// Limiter is a fixed-window counter keyed by IP and/or issuer|subject.
// Without a WindowCounter the window is in-process and resets on restart.
// UseShared attaches a durable counter. FLOWFORGE_REPLICAS above 1 must
// boot with that counter; the budgets stay separate from workspace quotas.
type Limiter struct {
	mu      sync.Mutex
	windows map[string]*limitWindow
	limits  Limits
	backend WindowCounter
	shared  bool
}

type limitWindow struct {
	start time.Time
	count int
}

// NewLimiter builds a limiter. Nil-safe callers should still construct
// one — a nil limiter fails closed at the HTTP boundary.
func NewLimiter(in Limits) *Limiter {
	return &Limiter{
		windows: map[string]*limitWindow{},
		limits:  NormalizeLimits(in),
	}
}

// Limits returns the effective configuration.
func (l *Limiter) Limits() Limits {
	if l == nil {
		return DefaultLimits()
	}
	return l.limits
}

// UseShared attaches a durable window. A nil counter is ignored. Shared
// reports true only after a successful attach.
func (l *Limiter) UseShared(c WindowCounter) {
	if l == nil || c == nil {
		return
	}
	l.backend = c
	l.shared = true
}

// Shared reports whether a durable window is attached.
func (l *Limiter) Shared() bool {
	return l != nil && l.shared
}

// Allow reports whether key may proceed under limit for the current
// window. limit <= 0 is unlimited. A nil limiter denies (fail closed).
// A shared-store error also denies.
func (l *Limiter) Allow(key string, limit int, now time.Time) bool {
	ok, _, _ := l.Decide(context.Background(), key, limit, now)
	return ok
}

// Decide applies the fixed window. A shared-store error is returned so
// the HTTP layer can fail closed with 503. retryAfter is the remaining
// window on deny.
func (l *Limiter) Decide(ctx context.Context, key string, limit int, now time.Time) (bool, time.Duration, error) {
	if l == nil {
		return false, DefaultRateWindow, nil
	}
	if limit <= 0 {
		return true, 0, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	key = strings.TrimSpace(key)
	if key == "" {
		key = "unknown"
	}
	now = now.UTC()
	window := l.limits.Window
	if window <= 0 {
		window = DefaultRateWindow
	}
	if l.backend != nil {
		ok, retry, err := l.backend.Allow(ctx, key, limit, window, now)
		if err != nil {
			return false, window, err
		}
		if !ok {
			if retry <= 0 {
				retry = window
			}
			return false, retry, nil
		}
		return true, 0, nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.windows) > 4096 {
		l.pruneLocked(now)
	}
	w := l.windows[key]
	if w == nil || now.Sub(w.start) >= window {
		w = &limitWindow{start: now, count: 0}
		l.windows[key] = w
	}
	if w.count >= limit {
		retry := window - now.Sub(w.start)
		if retry < time.Second {
			retry = time.Second
		}
		return false, retry, nil
	}
	w.count++
	return true, 0, nil
}

// RetryAfter is the remaining window for Retry-After. Zero if unlimited
// or the limiter is nil.
func (l *Limiter) RetryAfter(now time.Time) time.Duration {
	if l == nil {
		return DefaultRateWindow
	}
	if l.limits.Window <= 0 {
		return DefaultRateWindow
	}
	return l.limits.Window
}

func (l *Limiter) pruneLocked(now time.Time) {
	for key, w := range l.windows {
		if now.Sub(w.start) >= l.limits.Window {
			delete(l.windows, key)
		}
	}
}

// IPKey is the rate-limit key for a client address.
func IPKey(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return "ip:unknown"
	}
	return "ip:" + ip
}

// PrincipalKey is the rate-limit key for an issuer|subject pair.
func PrincipalKey(issuer, subject string) string {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	if issuer == "" && subject == "" {
		return ""
	}
	return "principal:" + issuer + "|" + subject
}
