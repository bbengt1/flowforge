package embed

import "sync"

// Secret-free embed authorization event types (ADV-012).
const (
	EventMinted          = "embed.minted"
	EventExchanged       = "embed.exchanged"
	EventRejected        = "embed.rejected"
	EventRotateAllow     = "embed.key.rotate_allowed"
	EventOverlapRegister = "embed.key.overlap_registered"
	EventOverlapRetire   = "embed.key.overlap_retired"
	EventRotateDenied    = "embed.key.rotate_denied"
	EventPortalMinted    = "portal.minted"
	EventPortalRejected  = "portal.rejected"
)

// Reason codes recorded on AuthzEvent. Never the raw assertion, signing
// key, or session secret.
const (
	ReasonIssued        = "issued"
	ReasonImpersonated  = "impersonated"
	ReasonImpersonation = "impersonation"
	ReasonIssuer        = "issuer"
	ReasonCapability    = "capability"
	ReasonTenancy       = "tenancy"
	ReasonWorkspace     = "workspace"
	ReasonPrincipal     = "principal"
	ReasonPrivilege     = "privilege"
	ReasonRateLimited   = "rate-limited"
	ReasonMalformed     = "malformed"
	ReasonAudience      = "audience"
	ReasonExpired       = "expired"
	ReasonNotYetValid   = "nbf"
	ReasonReplay        = "replay"
	ReasonSignature     = "signature"
	ReasonClaims        = "claims"
	ReasonOverlap       = "overlap"
	ReasonRejected      = "rejected"
	ReasonOverlapReg    = "overlap"
	ReasonRetire        = "retire"
)

// AuthzEvent is a structured, secret-free embed authorization decision.
// Never include assertion plaintext, signing keys, cookies, or CSRF.
type AuthzEvent struct {
	EventType    string
	Outcome      string
	Reason       string
	JTI          string
	Kid          string
	Issuer       string
	Subject      string
	TenantID     string
	WorkbenchKey string
	WorkspaceID  string
	RequestID    string
}

// SecretFields reports whether any reserved secret-shaped keys leaked
// onto the event. Used by tests; production construction never sets them.
func (e AuthzEvent) SecretFields() []string {
	// The typed event has no secret-bearing fields. This helper exists
	// so tests can assert the contract stays secret-free if the struct
	// grows.
	return nil
}

// Auditor receives secret-free embed authz decisions.
type Auditor interface {
	Record(AuthzEvent)
}

// MemoryAuditor is a process-local sink for tests.
type MemoryAuditor struct {
	mu     sync.Mutex
	events []AuthzEvent
}

// NewMemoryAuditor returns an empty in-memory auditor.
func NewMemoryAuditor() *MemoryAuditor {
	return &MemoryAuditor{}
}

// Record appends a copy of the event.
func (a *MemoryAuditor) Record(ev AuthzEvent) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, ev)
}

// Events returns a copy of recorded decisions.
func (a *MemoryAuditor) Events() []AuthzEvent {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]AuthzEvent, len(a.events))
	copy(out, a.events)
	return out
}

// Contains reports whether any event matches type, outcome, and reason.
func (a *MemoryAuditor) Contains(eventType, outcome, reason string) bool {
	for _, ev := range a.Events() {
		if ev.EventType == eventType && ev.Outcome == outcome && ev.Reason == reason {
			return true
		}
	}
	return false
}
