package localauth

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Documented defaults for unauthenticated POST /login. Sized so a
// legitimate operator can retry a mistyped password, while unlimited
// bcrypt guesses and concurrent hash work are cut off. Separate from
// embed exchange — do not share that IP budget.
const (
	DefaultRateWindow      = time.Minute
	DefaultIPLimit         = 60
	DefaultIdentifierLimit = 30

	EnvRateLimitIP         = "LOGIN_RATE_LIMIT_IP"
	EnvRateLimitIdentifier = "LOGIN_RATE_LIMIT_IDENTIFIER"
	EnvRateLimitWindow     = "LOGIN_RATE_LIMIT_WINDOW"
)

// Limits are per-process local-login rate limits. Zero fields become
// defaults. A negative limit is unlimited (ops/test escape hatch).
type Limits struct {
	Window     time.Duration
	PerIP      int
	Identifier int
}

// DefaultLimits returns documented POST /login defaults.
func DefaultLimits() Limits {
	return Limits{
		Window:     DefaultRateWindow,
		PerIP:      DefaultIPLimit,
		Identifier: DefaultIdentifierLimit,
	}
}

// NormalizeLimits fills zero fields with defaults. Negative limits stay
// negative (unlimited). Window <= 0 becomes DefaultRateWindow.
func NormalizeLimits(in Limits) Limits {
	out := DefaultLimits()
	if in.Window > 0 {
		out.Window = in.Window
	}
	if in.PerIP != 0 {
		out.PerIP = in.PerIP
	}
	if in.Identifier != 0 {
		out.Identifier = in.Identifier
	}
	return out
}

// LoadLimits reads LOGIN_* rate-limit env vars. Invalid or empty values
// use documented defaults. A set value of 0 is treated as default (do
// not fail closed on a typo of "0"); use a negative number for unlimited.
func LoadLimits() Limits {
	return NormalizeLimits(Limits{
		Window:     durationEnv(EnvRateLimitWindow, 0),
		PerIP:      intEnv(EnvRateLimitIP, 0),
		Identifier: intEnv(EnvRateLimitIdentifier, 0),
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

// IPKey is the login rate-limit key for a client address. Prefixed so
// it never collides with embed counters if a limiter is reused by
// mistake.
func IPKey(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return "login:ip:unknown"
	}
	return "login:ip:" + ip
}

// IdentifierKey is the login rate-limit key for a normalized identifier.
func IdentifierKey(identifier string) string {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return "login:id:unknown"
	}
	return "login:id:" + identifier
}
