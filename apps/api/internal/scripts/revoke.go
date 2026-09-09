package scripts

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// RevokeInput is a workspace-scoped artifact revocation request.
type RevokeInput struct {
	ArtifactID string
	Reason     string
	Now        time.Time
}

// AuthorizeRevoke is deny-by-default: script.revoke is required.
func AuthorizeRevoke(perms []string) error {
	if !authz.Allows(perms, authz.PermScriptRevoke) {
		return engineError(CodePermissionDenied, "caller is not authorized to revoke script artifacts.", http.StatusForbidden)
	}
	return nil
}

// ValidateRevokeReason rejects oversized or secret-bearing operator notes.
func ValidateRevokeReason(reason string) error {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return nil
	}
	if !utf8.ValidString(reason) {
		return engineError(CodeInvalidSource, "revoke reason must be valid UTF-8.", http.StatusBadRequest)
	}
	if len(reason) > MaxRevokeReasonBytes {
		return engineError(CodeSizeLimit, "revoke reason exceeds 256 bytes.", http.StatusBadRequest)
	}
	if irredactableSecret([]byte(reason)) {
		return engineError(CodeSecretForbidden, "Secret material is not allowed in revoke reason.", http.StatusBadRequest)
	}
	if _, changed := redactTokens(reason); changed {
		return engineError(CodeSecretForbidden, "Secret material is not allowed in revoke reason.", http.StatusBadRequest)
	}
	return nil
}

// Revoke marks a published artifact revoked. Idempotent when already revoked.
// Revoked artifacts fail VerifyForDispatch and cannot start.
func (p *Pipeline) Revoke(ctx context.Context, scope isolation.Scope, in RevokeInput) (Artifact, error) {
	if p == nil || p.Store == nil {
		return Artifact{}, ErrStoreUnavailable
	}
	id := strings.TrimSpace(in.ArtifactID)
	if !authz.ValidUUID(id) {
		return Artifact{}, ErrNotFound
	}
	if err := ValidateRevokeReason(in.Reason); err != nil {
		return Artifact{}, err
	}
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return p.Store.Revoke(ctx, scope, id, now, scope.ActorID(), strings.TrimSpace(in.Reason))
}

// ArtifactIsRevoked reports a non-zero revoked_at.
func ArtifactIsRevoked(art Artifact) bool {
	return art.RevokedAt != nil && !art.RevokedAt.IsZero()
}

// RevokeAudit is the secret-free audit payload for artifact revocation.
func RevokeAudit(art Artifact, actorID, reason string) map[string]any {
	out := map[string]any{
		"action":         AuditRevoke,
		"artifactId":     art.ID,
		"artifactDigest": art.Digest,
		"scanStatus":     art.ScanStatus,
		"language":       art.Language,
	}
	if actorID != "" {
		out["actorId"] = actorID
	}
	if art.RevokedAt != nil {
		out["revokedAt"] = art.RevokedAt.UTC().Format(time.RFC3339)
	}
	if reason != "" {
		out["reason"] = reason
	}
	return out
}
