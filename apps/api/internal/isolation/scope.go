package isolation

import (
	"errors"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Errors for scoped workspace resources.
var (
	ErrNotFound  = errors.New("not found")
	ErrInvalid   = errors.New("invalid")
	ErrConflict  = errors.New("conflict")
	ErrNoScope   = errors.New("workspace scope is not set")
	ErrForbidden = errors.New("forbidden")
)

// Kind is a workspace-owned isolation surface that exists today.
const (
	KindCredential = "credential"
	KindArtifact   = "artifact"
	KindJob        = "job"
	KindCache      = "cache"
	KindRealtime   = "realtime"
	KindAudit      = "audit"
)

// Kinds is the closed set of isolation hook kinds.
func Kinds() []string {
	return []string{KindCredential, KindArtifact, KindJob, KindCache, KindRealtime, KindAudit}
}

// ValidKind reports whether kind is a known isolation surface.
func ValidKind(kind string) bool {
	for _, k := range Kinds() {
		if k == kind {
			return true
		}
	}
	return false
}

// Scope is server-derived workspace context. Construct only after
// host identity and workspace membership/permission checks succeed.
type Scope struct {
	workspaceID  string
	actorID      string
	tenantID     string
	workbenchKey string
}

// Authorize returns a scope for an already-authorized workspace and actor.
func Authorize(workspaceID, actorID string) (Scope, error) {
	return AuthorizeTenancy(workspaceID, actorID, "", "")
}

// AuthorizeTenancy returns a scope that also carries the unique
// (tenant_id, workbench_key) workspace identity for embed propagation.
func AuthorizeTenancy(workspaceID, actorID, tenantID, workbenchKey string) (Scope, error) {
	if !authz.ValidUUID(workspaceID) {
		return Scope{}, ErrNoScope
	}
	if actorID != "" && !authz.ValidUUID(actorID) {
		return Scope{}, ErrInvalid
	}
	if tenantID != "" && !authz.ValidUUID(tenantID) {
		return Scope{}, ErrInvalid
	}
	if workbenchKey != "" && !authz.ValidWorkbenchKey(workbenchKey) {
		return Scope{}, ErrInvalid
	}
	return Scope{
		workspaceID:  workspaceID,
		actorID:      actorID,
		tenantID:     tenantID,
		workbenchKey: workbenchKey,
	}, nil
}

// WorkspaceID is the server-derived workspace.
func (s Scope) WorkspaceID() string { return s.workspaceID }

// ActorID is the authorized principal, when known.
func (s Scope) ActorID() string { return s.actorID }

// TenantID is the server-derived tenant when tenancy was propagated.
func (s Scope) TenantID() string { return s.tenantID }

// WorkbenchKey is the server-derived workbench when tenancy was propagated.
func (s Scope) WorkbenchKey() string { return s.workbenchKey }

// StampTenancy copies (tenant_id, workbench_key) onto metadata. Host
// values in the input map cannot override the server-derived identity.
func StampTenancy(meta map[string]any, scope Scope) map[string]any {
	if meta == nil {
		meta = map[string]any{}
	} else {
		out := make(map[string]any, len(meta)+2)
		for k, v := range meta {
			out[k] = v
		}
		meta = out
	}
	if scope.tenantID != "" {
		meta["tenant_id"] = scope.tenantID
	}
	if scope.workbenchKey != "" {
		meta["workbench_key"] = scope.workbenchKey
	}
	return meta
}

// Zero reports whether the scope was never authorized.
func (s Scope) Zero() bool { return s.workspaceID == "" }

// PermissionFor is the deny-by-default action required for a kind.
func PermissionFor(kind, action string) string {
	switch kind {
	case KindCredential:
		switch action {
		case "write":
			return authz.PermCredentialManage
		case "use":
			return authz.PermCredentialUse
		default:
			return authz.PermCredentialView
		}
	case KindArtifact:
		return authz.PermExecutionView
	case KindJob:
		if action == "write" {
			return authz.PermWorkflowExecute
		}
		return authz.PermExecutionView
	case KindAudit:
		return authz.PermWorkspaceAdminister
	case KindCache, KindRealtime:
		return authz.PermWorkflowView
	default:
		return ""
	}
}
