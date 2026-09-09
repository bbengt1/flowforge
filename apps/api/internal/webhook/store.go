// Package webhook persists replay-safe webhook trigger configuration and
// enforces signature, timestamp, replay, and rate/concurrency gates.
package webhook

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Persistence and ingress errors.
var (
	ErrNotFound         = errors.New("not found")
	ErrConflict         = errors.New("conflict")
	ErrInvalid          = errors.New("invalid")
	ErrNoScope          = errors.New("workspace scope is not set")
	ErrDisabled         = errors.New("webhook trigger is disabled")
	ErrReplay           = errors.New("webhook delivery was replayed")
	ErrRateLimited      = errors.New("webhook rate limit exceeded")
	ErrConcurrency      = errors.New("webhook concurrency limit exceeded")
	ErrBadSignature     = errors.New("webhook signature is invalid")
	ErrTimestampSkew    = errors.New("webhook timestamp is outside the allowed skew")
	ErrTooLarge         = errors.New("webhook body exceeds the size limit")
	ErrUnsupportedType  = errors.New("webhook content type is not accepted")
	ErrSecretType       = errors.New("webhook secret must be a webhook_secret credential")
	ErrSecretDisabled   = errors.New("webhook secret credential is not active")
	ErrUnpublished      = errors.New("webhook trigger must pin a published workflow version")
	ErrStoreUnavailable = errors.New("webhook store is unavailable")
)

// Lifecycle and type values.
const (
	TypeWebhook    = "webhook"
	StatusEnabled  = "enabled"
	StatusDisabled = "disabled"

	DefaultMaxBodyBytes           = 64 * 1024
	HardMaxBodyBytes              = 256 * 1024
	DefaultClockSkewSeconds       = 300
	DefaultReplayRetentionSeconds = 600
	DefaultRatePerMinute          = 60
	DefaultWorkspaceRatePerMinute = 300
	DefaultMaxConcurrency         = 5
	DefaultWorkspaceConcurrency   = 20
	HardRatePerMinute             = 600
	HardWorkspaceRatePerMinute    = 3000
	HardMaxConcurrency            = 20
	HardWorkspaceConcurrency      = 100
	HardClockSkewSeconds          = 3600
	HardReplayRetentionSeconds    = 7200

	SignatureHeader  = "X-FlowForge-Signature"
	TimestampHeader  = "X-FlowForge-Timestamp"
	SignatureVersion = "v1"
	PublicIDPrefix   = "wh_"
)

// Trigger is safe webhook configuration. It never includes the secret.
type Trigger struct {
	ID                      string            `json:"id"`
	PublicID                string            `json:"publicId"`
	IngressPath             string            `json:"ingressPath"`
	WorkflowID              string            `json:"workflowId"`
	WorkflowVersionID       string            `json:"workflowVersionId"`
	Type                    string            `json:"type"`
	Status                  string            `json:"status"`
	SecretCredentialID      string            `json:"secretCredentialId"`
	ContentType             string            `json:"contentType"`
	FieldMapping            map[string]string `json:"fieldMapping"`
	MaxBodyBytes            int               `json:"maxBodyBytes"`
	ClockSkewSeconds        int               `json:"clockSkewSeconds"`
	ReplayRetentionSeconds  int               `json:"replayRetentionSeconds"`
	RateLimitPerMinute      int               `json:"rateLimitPerMinute"`
	WorkspaceRatePerMinute  int               `json:"workspaceRatePerMinute"`
	MaxConcurrency          int               `json:"maxConcurrency"`
	WorkspaceMaxConcurrency int               `json:"workspaceMaxConcurrency"`
	CreatedBy               string            `json:"createdBy,omitempty"`
	UpdatedBy               string            `json:"updatedBy,omitempty"`
	CreatedAt               time.Time         `json:"createdAt"`
	UpdatedAt               time.Time         `json:"updatedAt"`
}

// CreateInput creates a workspace-scoped webhook trigger.
type CreateInput struct {
	WorkflowID              string
	WorkflowVersionID       string
	SecretCredentialID      string
	ContentType             string
	FieldMapping            map[string]string
	MaxBodyBytes            int
	ClockSkewSeconds        int
	ReplayRetentionSeconds  int
	RateLimitPerMinute      int
	WorkspaceRatePerMinute  int
	MaxConcurrency          int
	WorkspaceMaxConcurrency int
}

// UpdateInput changes safe trigger metadata. Secret rotation is separate.
type UpdateInput struct {
	WorkflowVersionID       *string
	SecretCredentialID      *string
	ContentType             *string
	FieldMapping            *map[string]string
	MaxBodyBytes            *int
	ClockSkewSeconds        *int
	ReplayRetentionSeconds  *int
	RateLimitPerMinute      *int
	WorkspaceRatePerMinute  *int
	MaxConcurrency          *int
	WorkspaceMaxConcurrency *int
}

// DeliveryLimits are the live rate/replay gates for one ingress attempt.
type DeliveryLimits struct {
	ReplayID                string
	ReplayRetention         time.Duration
	RateLimitPerMinute      int
	WorkspaceRatePerMinute  int
	MaxConcurrency          int
	WorkspaceMaxConcurrency int
}

// Store persists webhook triggers and delivery gates under workspace scope.
type Store interface {
	Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Trigger, error)
	List(ctx context.Context, scope isolation.Scope, workflowID string) ([]Trigger, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Trigger, error)
	Update(ctx context.Context, scope isolation.Scope, id string, in UpdateInput) (Trigger, error)
	SetStatus(ctx context.Context, scope isolation.Scope, id, status string) (Trigger, error)
	Delete(ctx context.Context, scope isolation.Scope, id string) error
	LookupPublic(ctx context.Context, publicID string) (workspaceID string, trigger Trigger, err error)
	AcquireDelivery(ctx context.Context, scope isolation.Scope, triggerID string, now time.Time, limits DeliveryLimits) error
	ReleaseDelivery(ctx context.Context, scope isolation.Scope, triggerID string, now time.Time)
	FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]wfstore.CredentialRef, error)
}

// IngressPathFor returns the public route for an opaque trigger ID.
func IngressPathFor(publicID string) string {
	return "/api/v1/hooks/" + strings.TrimSpace(publicID)
}

func newPublicID() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return PublicIDPrefix + hex.EncodeToString(b[:]), nil
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func normalizeCreate(scope isolation.Scope, in CreateInput, now time.Time) (Trigger, error) {
	if scope.Zero() {
		return Trigger{}, ErrNoScope
	}
	if !authz.ValidUUID(in.WorkflowID) || !authz.ValidUUID(in.WorkflowVersionID) {
		return Trigger{}, ErrUnpublished
	}
	if !authz.ValidUUID(in.SecretCredentialID) {
		return Trigger{}, ErrInvalid
	}
	trig := Trigger{
		ID:                      newUUID(),
		WorkflowID:              strings.TrimSpace(in.WorkflowID),
		WorkflowVersionID:       strings.TrimSpace(in.WorkflowVersionID),
		Type:                    TypeWebhook,
		Status:                  StatusEnabled,
		SecretCredentialID:      strings.TrimSpace(in.SecretCredentialID),
		ContentType:             firstNonEmpty(strings.TrimSpace(in.ContentType), "application/json"),
		FieldMapping:            sanitizeMapping(in.FieldMapping),
		MaxBodyBytes:            pickLimit(in.MaxBodyBytes, DefaultMaxBodyBytes, 1, HardMaxBodyBytes),
		ClockSkewSeconds:        pickLimit(in.ClockSkewSeconds, DefaultClockSkewSeconds, 1, HardClockSkewSeconds),
		ReplayRetentionSeconds:  pickLimit(in.ReplayRetentionSeconds, DefaultReplayRetentionSeconds, 1, HardReplayRetentionSeconds),
		RateLimitPerMinute:      pickLimit(in.RateLimitPerMinute, DefaultRatePerMinute, 1, HardRatePerMinute),
		WorkspaceRatePerMinute:  pickLimit(in.WorkspaceRatePerMinute, DefaultWorkspaceRatePerMinute, 1, HardWorkspaceRatePerMinute),
		MaxConcurrency:          pickLimit(in.MaxConcurrency, DefaultMaxConcurrency, 1, HardMaxConcurrency),
		WorkspaceMaxConcurrency: pickLimit(in.WorkspaceMaxConcurrency, DefaultWorkspaceConcurrency, 1, HardWorkspaceConcurrency),
		CreatedBy:               scope.ActorID(),
		UpdatedBy:               scope.ActorID(),
		CreatedAt:               now,
		UpdatedAt:               now,
	}
	if trig.ReplayRetentionSeconds < trig.ClockSkewSeconds {
		trig.ReplayRetentionSeconds = trig.ClockSkewSeconds
	}
	if err := validateContentType(trig.ContentType); err != nil {
		return Trigger{}, err
	}
	if err := validateMapping(trig.FieldMapping); err != nil {
		return Trigger{}, err
	}
	publicID, err := newPublicID()
	if err != nil {
		return Trigger{}, err
	}
	trig.PublicID = publicID
	trig.IngressPath = IngressPathFor(publicID)
	return trig, nil
}

func applyUpdate(trig Trigger, in UpdateInput, actor string, now time.Time) (Trigger, error) {
	if in.WorkflowVersionID != nil {
		id := strings.TrimSpace(*in.WorkflowVersionID)
		if !authz.ValidUUID(id) {
			return Trigger{}, ErrUnpublished
		}
		trig.WorkflowVersionID = id
	}
	if in.SecretCredentialID != nil {
		id := strings.TrimSpace(*in.SecretCredentialID)
		if !authz.ValidUUID(id) {
			return Trigger{}, ErrInvalid
		}
		trig.SecretCredentialID = id
	}
	if in.ContentType != nil {
		trig.ContentType = strings.TrimSpace(*in.ContentType)
		if err := validateContentType(trig.ContentType); err != nil {
			return Trigger{}, err
		}
	}
	if in.FieldMapping != nil {
		trig.FieldMapping = sanitizeMapping(*in.FieldMapping)
		if err := validateMapping(trig.FieldMapping); err != nil {
			return Trigger{}, err
		}
	}
	if in.MaxBodyBytes != nil {
		trig.MaxBodyBytes = pickLimit(*in.MaxBodyBytes, trig.MaxBodyBytes, 1, HardMaxBodyBytes)
	}
	if in.ClockSkewSeconds != nil {
		trig.ClockSkewSeconds = pickLimit(*in.ClockSkewSeconds, trig.ClockSkewSeconds, 1, HardClockSkewSeconds)
	}
	if in.ReplayRetentionSeconds != nil {
		trig.ReplayRetentionSeconds = pickLimit(*in.ReplayRetentionSeconds, trig.ReplayRetentionSeconds, 1, HardReplayRetentionSeconds)
	}
	if in.RateLimitPerMinute != nil {
		trig.RateLimitPerMinute = pickLimit(*in.RateLimitPerMinute, trig.RateLimitPerMinute, 1, HardRatePerMinute)
	}
	if in.WorkspaceRatePerMinute != nil {
		trig.WorkspaceRatePerMinute = pickLimit(*in.WorkspaceRatePerMinute, trig.WorkspaceRatePerMinute, 1, HardWorkspaceRatePerMinute)
	}
	if in.MaxConcurrency != nil {
		trig.MaxConcurrency = pickLimit(*in.MaxConcurrency, trig.MaxConcurrency, 1, HardMaxConcurrency)
	}
	if in.WorkspaceMaxConcurrency != nil {
		trig.WorkspaceMaxConcurrency = pickLimit(*in.WorkspaceMaxConcurrency, trig.WorkspaceMaxConcurrency, 1, HardWorkspaceConcurrency)
	}
	if trig.ReplayRetentionSeconds < trig.ClockSkewSeconds {
		trig.ReplayRetentionSeconds = trig.ClockSkewSeconds
	}
	trig.UpdatedBy = actor
	trig.UpdatedAt = now
	trig.IngressPath = IngressPathFor(trig.PublicID)
	return trig, nil
}

func pickLimit(value, fallback, min, max int) int {
	if value == 0 {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func cloneTrigger(t Trigger) Trigger {
	out := t
	out.FieldMapping = sanitizeMapping(t.FieldMapping)
	out.IngressPath = IngressPathFor(t.PublicID)
	return out
}

func publicIDLooksValid(id string) bool {
	id = strings.TrimSpace(id)
	if !strings.HasPrefix(id, PublicIDPrefix) {
		return false
	}
	rest := strings.TrimPrefix(id, PublicIDPrefix)
	if len(rest) != 64 {
		return false
	}
	_, err := hex.DecodeString(rest)
	return err == nil
}
