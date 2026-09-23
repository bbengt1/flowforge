// Package quota is the shared token bucket for workspace quotas and the
// shared fixed window for auth doors (local login, embed, machine).
// PostgreSQL is the multi-replica store. One process may use memory.
// A store error denies the request (fail closed). Login and embed
// budgets stay on their own keys; they are not workspace buckets.
package quota

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

// Classes are workspace buckets. Auth doors do not use these.
const (
	ClassMutate   = "mutate"
	ClassRead     = "read"
	ClassDownload = "download"
	ClassExecute  = "execute"
)

const (
	EnvMutatePerMinute        = "QUOTA_MUTATE_PER_MINUTE"
	EnvMutateBurst            = "QUOTA_MUTATE_BURST"
	EnvReadPerMinute          = "QUOTA_READ_PER_MINUTE"
	EnvReadBurst              = "QUOTA_READ_BURST"
	EnvDownloadPerMinute      = "QUOTA_DOWNLOAD_PER_MINUTE"
	EnvDownloadBurst          = "QUOTA_DOWNLOAD_BURST"
	EnvExecutePerMinute       = "QUOTA_EXECUTE_PER_MINUTE"
	EnvExecuteBurst           = "QUOTA_EXECUTE_BURST"
	EnvExecuteConcurrency     = "QUOTA_EXECUTE_CONCURRENCY"
	DefaultMutatePerMinute    = 120
	DefaultMutateBurst        = 120
	DefaultReadPerMinute      = 300
	DefaultReadBurst          = 300
	DefaultDownloadPerMinute  = 60
	DefaultDownloadBurst      = 60
	DefaultExecutePerMinute   = 30
	DefaultExecuteBurst       = 30
	DefaultExecuteConcurrency = 20
	maxQuota                  = 100000
)

// Limits are workspace quotas. Zero fields become defaults. A negative
// field is unlimited. ExecuteConcurrency caps non-terminal executions
// in the workspace (manual start, webhook, and schedule share it).
type Limits struct {
	MutatePerMinute    int
	MutateBurst        int
	ReadPerMinute      int
	ReadBurst          int
	DownloadPerMinute  int
	DownloadBurst      int
	ExecutePerMinute   int
	ExecuteBurst       int
	ExecuteConcurrency int
}

// DefaultLimits returns the documented production budgets.
func DefaultLimits() Limits {
	return Limits{
		MutatePerMinute:    DefaultMutatePerMinute,
		MutateBurst:        DefaultMutateBurst,
		ReadPerMinute:      DefaultReadPerMinute,
		ReadBurst:          DefaultReadBurst,
		DownloadPerMinute:  DefaultDownloadPerMinute,
		DownloadBurst:      DefaultDownloadBurst,
		ExecutePerMinute:   DefaultExecutePerMinute,
		ExecuteBurst:       DefaultExecuteBurst,
		ExecuteConcurrency: DefaultExecuteConcurrency,
	}
}

// Unlimited disables every workspace bucket. HTTP unit tests use this
// so a long case does not trip the production defaults. Production
// config.Load does not call it.
func Unlimited() Limits {
	return Limits{
		MutatePerMinute:    -1,
		MutateBurst:        -1,
		ReadPerMinute:      -1,
		ReadBurst:          -1,
		DownloadPerMinute:  -1,
		DownloadBurst:      -1,
		ExecutePerMinute:   -1,
		ExecuteBurst:       -1,
		ExecuteConcurrency: -1,
	}
}

// IsZero reports whether no field was set.
func (l Limits) IsZero() bool {
	return l == (Limits{})
}

// Normalize fills zero fields from the defaults. A negative value stays
// unlimited. An unset burst follows the per-minute rate. Values above
// maxQuota are clamped so a row cannot fail the token check.
func Normalize(in Limits) Limits {
	out := DefaultLimits()
	out.MutatePerMinute = pick(in.MutatePerMinute, out.MutatePerMinute)
	out.ReadPerMinute = pick(in.ReadPerMinute, out.ReadPerMinute)
	out.DownloadPerMinute = pick(in.DownloadPerMinute, out.DownloadPerMinute)
	out.ExecutePerMinute = pick(in.ExecutePerMinute, out.ExecutePerMinute)
	out.ExecuteConcurrency = pick(in.ExecuteConcurrency, out.ExecuteConcurrency)
	out.MutateBurst = pickBurst(in.MutateBurst, in.MutatePerMinute, out.MutateBurst, out.MutatePerMinute)
	out.ReadBurst = pickBurst(in.ReadBurst, in.ReadPerMinute, out.ReadBurst, out.ReadPerMinute)
	out.DownloadBurst = pickBurst(in.DownloadBurst, in.DownloadPerMinute, out.DownloadBurst, out.DownloadPerMinute)
	out.ExecuteBurst = pickBurst(in.ExecuteBurst, in.ExecutePerMinute, out.ExecuteBurst, out.ExecutePerMinute)
	return out
}

// Load reads QUOTA_* env vars. Empty, zero, and non-integers use the
// documented defaults. A negative number is unlimited.
func Load() Limits {
	return Normalize(Limits{
		MutatePerMinute:    intEnv(EnvMutatePerMinute),
		MutateBurst:        intEnv(EnvMutateBurst),
		ReadPerMinute:      intEnv(EnvReadPerMinute),
		ReadBurst:          intEnv(EnvReadBurst),
		DownloadPerMinute:  intEnv(EnvDownloadPerMinute),
		DownloadBurst:      intEnv(EnvDownloadBurst),
		ExecutePerMinute:   intEnv(EnvExecutePerMinute),
		ExecuteBurst:       intEnv(EnvExecuteBurst),
		ExecuteConcurrency: intEnv(EnvExecuteConcurrency),
	})
}

func pick(v, def int) int {
	if v == 0 {
		return def
	}
	if v > maxQuota {
		return maxQuota
	}
	return v
}

func pickBurst(burst, perMinute, defBurst, defPerMinute int) int {
	if burst == 0 {
		if perMinute == 0 {
			return defBurst
		}
		if perMinute < 0 {
			return -1
		}
		return pick(perMinute, defPerMinute)
	}
	return pick(burst, defBurst)
}

func intEnv(name string) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return n
}

// Bucket is the token-bucket shape for a class. Unlimited is true when
// the class does not consume a budget. known is false for an unknown class.
func (l Limits) Bucket(class string) (capacity, refillPerSec float64, unlimited, known bool) {
	var perMinute, burst int
	switch class {
	case ClassMutate:
		perMinute, burst = l.MutatePerMinute, l.MutateBurst
	case ClassRead:
		perMinute, burst = l.ReadPerMinute, l.ReadBurst
	case ClassDownload:
		perMinute, burst = l.DownloadPerMinute, l.DownloadBurst
	case ClassExecute:
		perMinute, burst = l.ExecutePerMinute, l.ExecuteBurst
	default:
		return 0, 0, false, false
	}
	known = true
	if perMinute < 0 || burst < 0 {
		return 0, 0, true, true
	}
	if perMinute == 0 || burst == 0 {
		return 0, 0, true, true
	}
	return float64(burst), float64(perMinute) / 60.0, false, true
}

// KnownClass reports whether class is a workspace bucket.
func KnownClass(class string) bool {
	switch class {
	case ClassMutate, ClassRead, ClassDownload, ClassExecute:
		return true
	default:
		return false
	}
}

// KeyHash is the sha256 hex of a limiter key. Auth-door rows store this
// and not the identifier or client IP.
func KeyHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// Decision is one allow or deny. RetryAfter is set on deny.
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration
}

// Taker is the workspace token bucket. A nil taker fails closed at the
// HTTP boundary. Memory is unshared. Postgres is shared.
type Taker interface {
	Take(ctx context.Context, workspaceID, class string, capacity, refillPerSec float64, now time.Time) (Decision, error)
}

func retryFor(available, refillPerSec float64) time.Duration {
	if refillPerSec <= 0 {
		return time.Minute
	}
	deficit := 1 - available
	if deficit < 0 {
		deficit = 0
	}
	retry := time.Duration(deficit / refillPerSec * float64(time.Second))
	if retry < time.Second {
		return time.Second
	}
	if retry > 24*time.Hour {
		return 24 * time.Hour
	}
	return retry
}

func refill(tokens float64, updated, now time.Time, capacity, refillPerSec float64) float64 {
	elapsed := now.Sub(updated).Seconds()
	if elapsed < 0 || math.IsNaN(elapsed) || math.IsInf(elapsed, 0) {
		elapsed = 0
	}
	available := tokens + elapsed*refillPerSec
	if available > capacity {
		return capacity
	}
	if available < 0 {
		return 0
	}
	return available
}
