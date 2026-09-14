// Package bootstrap persists the instance-level first-run wizard gate.
// Status responses are secret-free. The public base URL is stored
// server-side for B.4 and is never returned by GET /api/v1/bootstrap.
package bootstrap

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"
)

// EnvPublicBaseURL is the optional compose/public URL used by localseed skip.
const EnvPublicBaseURL = "PUBLIC_BASE_URL"

// DefaultPublicBaseURL is the local compose UI origin. Seed uses this when
// PUBLIC_BASE_URL is unset so trusted-dev skip still has admin + URL.
const DefaultPublicBaseURL = "http://localhost:3000"

// SingletonID is the only allowed instance_bootstrap row.
const SingletonID = "default"

// TLS modes are status-only. Private keys never enter this package.
const (
	TLSModeNone       = "none"
	TLSModeSelfSigned = "self_signed"
	TLSModeUploaded   = "uploaded"
	TLSModeLocalHTTP  = "local_http"
)

// Step names match the OpenAPI / contract map (camelCase).
const (
	StepPersistence = "persistence"
	StepFirstAdmin  = "firstAdmin"
	StepPublicURL   = "publicUrl"
	StepTLS         = "tls"
)

// ErrUnavailable is returned when the store cannot be reached.
var ErrUnavailable = errors.New("bootstrap store unavailable")

// ErrInvalid is returned when a step name or public URL is rejected.
var ErrInvalid = errors.New("bootstrap input invalid")

// State is the durable singleton. PublicBaseURL is server-only.
type State struct {
	Complete         bool
	Skipped          bool
	PersistenceReady bool
	FirstAdminReady  bool
	PublicURLReady   bool
	TLSReady         bool
	PublicBaseURL    string
	TLSMode          string
	CompletedAt      *time.Time
	UpdatedAt        time.Time
}

// Status is the secret-free GET /api/v1/bootstrap body.
type Status struct {
	Complete       bool  `json:"complete"`
	Incomplete     bool  `json:"incomplete"`
	Skipped        bool  `json:"skipped"`
	StandaloneOnly bool  `json:"standaloneOnly"`
	Steps          Steps `json:"steps"`
}

// Steps is per-step readiness for Chloe progress / B.2–B.5 routing.
type Steps struct {
	Persistence Step `json:"persistence"`
	FirstAdmin  Step `json:"firstAdmin"`
	PublicURL   Step `json:"publicUrl"`
	TLS         Step `json:"tls"`
}

// Step is a single wizard step. Mode is TLS-only status (never a key).
type Step struct {
	Ready bool   `json:"ready"`
	Mode  string `json:"mode,omitempty"`
}

// SeedSkip is the trusted-dev / compose localseed complete path.
type SeedSkip struct {
	PublicBaseURL string
}

// Store persists the singleton bootstrap row.
type Store interface {
	Get(ctx context.Context) (State, error)
	SetStep(ctx context.Context, step string, ready bool) error
	SetPublicURL(ctx context.Context, publicBaseURL string) error
	SetTLS(ctx context.Context, ready bool, mode string) error
	MarkComplete(ctx context.Context) error
	MarkSeedSkip(ctx context.Context, skip SeedSkip) error
}

// Status projects secret-free flags. PublicBaseURL is omitted.
func (s State) Status() Status {
	tls := Step{Ready: s.TLSReady}
	if mode := strings.TrimSpace(s.TLSMode); mode != "" && mode != TLSModeNone {
		tls.Mode = mode
	}
	return Status{
		Complete:       s.Complete,
		Incomplete:     !s.Complete,
		Skipped:        s.Skipped,
		StandaloneOnly: true,
		Steps: Steps{
			Persistence: Step{Ready: s.PersistenceReady},
			FirstAdmin:  Step{Ready: s.FirstAdminReady},
			PublicURL:   Step{Ready: s.PublicURLReady},
			TLS:         tls,
		},
	}
}

// NormalizePublicBaseURL validates an optional http(s) public origin.
// Empty is valid (not configured). The URL is never a secret.
func NormalizePublicBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if len(raw) > 2048 {
		return "", ErrInvalid
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", ErrInvalid
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", ErrInvalid
	}
	if u.Path != "" && u.Path != "/" {
		return "", ErrInvalid
	}
	return u.Scheme + "://" + u.Host, nil
}

// ResolveSeedPublicURL returns the URL localseed should persist.
// Empty input becomes DefaultPublicBaseURL (local compose).
func ResolveSeedPublicURL(raw string) (string, error) {
	normalized, err := NormalizePublicBaseURL(raw)
	if err != nil {
		return "", err
	}
	if normalized == "" {
		return DefaultPublicBaseURL, nil
	}
	return normalized, nil
}

// NormalizeTLSMode accepts documented status-only TLS modes.
func NormalizeTLSMode(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return TLSModeNone, nil
	}
	switch raw {
	case TLSModeNone, TLSModeSelfSigned, TLSModeUploaded, TLSModeLocalHTTP:
		return raw, nil
	default:
		return "", ErrInvalid
	}
}

func validStep(step string) bool {
	switch step {
	case StepPersistence, StepFirstAdmin, StepPublicURL, StepTLS:
		return true
	default:
		return false
	}
}
