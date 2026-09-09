// Package opsalert emits secret-free operational alerts for authorization,
// replay, policy, and redaction failures.
package opsalert

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// Kind is a closed set of actionable security-failure signals.
const (
	KindAuthorization = "authorization"
	KindReplay        = "replay"
	KindPolicy        = "policy"
	KindRedaction     = "redaction"
)

// Severity values persisted on an alert.
const (
	SeverityWarning  = "warning"
	SeverityCritical = "critical"
)

// Default list window.
const DefaultListLimit = 50

// Persistence errors.
var (
	ErrNotFound         = errString("not found")
	ErrInvalid          = errString("invalid")
	ErrNoScope          = errString("workspace scope is not set")
	ErrStoreUnavailable = errString("alert store is unavailable")
)

type errString string

func (e errString) Error() string { return string(e) }

// Signal is an inbound failure event. Details may contain unsafe caller data;
// Sanitize keeps correlation/resource identifiers only.
type Signal struct {
	Kind          string
	Severity      string
	Action        string
	ResourceType  string
	ResourceID    string
	CorrelationID string
	RequestID     string
	ActorID       string
	Outcome       string
	Code          string
	Details       map[string]any
}

// Alert is the operator-visible, secret-free row. Details are never serialized.
type Alert struct {
	ID             string         `json:"id"`
	Kind           string         `json:"kind"`
	Severity       string         `json:"severity"`
	Action         string         `json:"action,omitempty"`
	ResourceType   string         `json:"resourceType,omitempty"`
	ResourceID     string         `json:"resourceId,omitempty"`
	CorrelationID  string         `json:"correlationId,omitempty"`
	RequestID      string         `json:"requestId,omitempty"`
	ActorID        string         `json:"actorId,omitempty"`
	Outcome        string         `json:"outcome"`
	Code           string         `json:"code"`
	AcknowledgedAt *time.Time     `json:"acknowledgedAt,omitempty"`
	AcknowledgedBy string         `json:"acknowledgedBy,omitempty"`
	OccurredAt     time.Time      `json:"occurredAt"`
	Details        map[string]any `json:"-"`
}

// ListFilter selects workspace-scoped alerts.
type ListFilter struct {
	Kind         string
	Status       string
	ResourceType string
	ResourceID   string
	Limit        int
}

// Store persists and acknowledges operational alerts.
type Store interface {
	Emit(ctx context.Context, scope isolation.Scope, in Signal) (Alert, error)
	List(ctx context.Context, scope isolation.Scope, filter ListFilter) ([]Alert, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Alert, error)
	Ack(ctx context.Context, scope isolation.Scope, id string) (Alert, error)
}

// Sink receives a sanitized alert after routing.
type Sink interface {
	Handle(ctx context.Context, scope isolation.Scope, alert Alert) error
}

// Router fans a sanitized signal out to registered sinks. Used by tests with
// safe fixtures and by the HTTP layer before persistence.
type Router struct {
	sinks []Sink
}

// NewRouter returns a router that delivers to sinks in registration order.
func NewRouter(sinks ...Sink) *Router {
	return &Router{sinks: append([]Sink(nil), sinks...)}
}

// Route sanitizes the signal and delivers the resulting alert to every sink.
func (r *Router) Route(ctx context.Context, scope isolation.Scope, in Signal) (Alert, error) {
	alert := AlertFromSignal(Sanitize(in), time.Now().UTC())
	if r == nil {
		return alert, nil
	}
	for _, sink := range r.sinks {
		if sink == nil {
			continue
		}
		if err := sink.Handle(ctx, scope, alert); err != nil {
			return Alert{}, err
		}
	}
	return alert, nil
}

// RecordingSink captures routed alerts for fixture tests.
type RecordingSink struct {
	Alerts []Alert
}

// Handle appends the alert.
func (s *RecordingSink) Handle(_ context.Context, _ isolation.Scope, alert Alert) error {
	if s == nil {
		return nil
	}
	s.Alerts = append(s.Alerts, alert)
	return nil
}

var identifierKey = regexp.MustCompile(`(?i)^(resource|execution|workflow|step|job|artifact|approval|alert|actor|user|request|correlation)[_-]?id$|^(code|kind|reason|action|resource[_-]?type|outcome)$`)

var secretKeyPart = regexp.MustCompile(`(?i)(password|passwd|secret|token|authorization|credential|api[_-]?key|private[_-]?key|kubeconfig|ciphertext|dek[_-]?envelope|bearer|cookie)`)

// KnownKind reports whether kind is an actionable E5.4 signal.
func KnownKind(kind string) bool {
	switch strings.TrimSpace(kind) {
	case KindAuthorization, KindReplay, KindPolicy, KindRedaction:
		return true
	default:
		return false
	}
}

// DefaultSeverity maps a kind to the documented default.
func DefaultSeverity(kind string) string {
	switch kind {
	case KindPolicy, KindRedaction:
		return SeverityCritical
	default:
		return SeverityWarning
	}
}

// Sanitize returns a copy that keeps identifier fields only. Secret keys and
// secret-shaped values are dropped, never echoed as "[redacted]".
func Sanitize(in Signal) Signal {
	out := Signal{
		Kind:          strings.TrimSpace(in.Kind),
		Severity:      strings.TrimSpace(in.Severity),
		Action:        clip(strings.TrimSpace(in.Action), 128),
		ResourceType:  clip(strings.TrimSpace(in.ResourceType), 64),
		ResourceID:    sanitizeID(in.ResourceID),
		CorrelationID: clip(strings.TrimSpace(in.CorrelationID), 128),
		RequestID:     clip(strings.TrimSpace(in.RequestID), 128),
		ActorID:       sanitizeID(in.ActorID),
		Outcome:       clip(firstNonEmpty(strings.TrimSpace(in.Outcome), "denied"), 64),
		Code:          clip(strings.TrimSpace(in.Code), 64),
		Details:       sanitizeDetails(in.Details),
	}
	if !KnownKind(out.Kind) {
		out.Kind = ""
	}
	if out.Severity != SeverityWarning && out.Severity != SeverityCritical {
		out.Severity = DefaultSeverity(out.Kind)
	}
	if looksLikeSecret(out.CorrelationID) {
		out.CorrelationID = ""
	}
	if looksLikeSecret(out.RequestID) {
		out.RequestID = ""
	}
	if looksLikeSecret(out.Action) {
		out.Action = ""
	}
	if looksLikeSecret(out.Code) {
		out.Code = ""
	}
	return out
}

// AlertFromSignal builds a persistable alert from an already-sanitized signal.
func AlertFromSignal(in Signal, now time.Time) Alert {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return Alert{
		Kind:          in.Kind,
		Severity:      in.Severity,
		Action:        in.Action,
		ResourceType:  in.ResourceType,
		ResourceID:    in.ResourceID,
		CorrelationID: in.CorrelationID,
		RequestID:     in.RequestID,
		ActorID:       in.ActorID,
		Outcome:       in.Outcome,
		Code:          in.Code,
		OccurredAt:    now,
		Details:       in.Details,
	}
}

func sanitizeDetails(in map[string]any) map[string]any {
	if len(in) == 0 {
		return map[string]any{}
	}
	out := map[string]any{}
	for k, v := range in {
		if !identifierKey.MatchString(strings.TrimSpace(k)) || secretKeyPart.MatchString(k) {
			continue
		}
		switch t := v.(type) {
		case string:
			s := strings.TrimSpace(t)
			if s == "" || looksLikeSecret(s) {
				continue
			}
			if strings.HasSuffix(strings.ToLower(k), "id") && sanitizeID(s) == "" {
				continue
			}
			out[k] = clip(s, 128)
		case bool:
			out[k] = t
		default:
			continue
		}
	}
	return out
}

func sanitizeID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" || !authz.ValidUUID(id) {
		return ""
	}
	return id
}

func looksLikeSecret(s string) bool {
	if s == "" {
		return false
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "bearer ") {
		return true
	}
	if strings.Contains(s, "BEGIN ") && strings.Contains(s, "PRIVATE KEY") {
		return true
	}
	if strings.Contains(s, "://") && strings.Contains(s, "@") {
		return true
	}
	return false
}

func clip(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	return s[:n]
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func listLimit(n int) int {
	if n <= 0 {
		return DefaultListLimit
	}
	if n > 100 {
		return 100
	}
	return n
}
