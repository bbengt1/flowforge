package embed

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// VerifyOptions controls assertion checks. Fail closed on iss/aud/nbf/exp/
// jti/capabilities. Workspace/tenant resolution is the caller's job
// after Verify succeeds (ADV-008). Host IDs remain untrusted until
// resolved. ResolvedWS is optional: when set, claim workspace_id must
// match; when empty, binding is deferred so callers can verify before
// any store lookup.
type VerifyOptions struct {
	Audience            string
	Now                 time.Time
	SkipJTI             bool
	Consumer            JTIConsumer
	ResolvedWS          string
	Context             context.Context
	AllowedIssuers      []string
	ExpectedHostIssuer  string
	HostContext         string
	EmbedIssuers        []string
	PortalIssuers       []string
	SelectPathAllowlist bool
	// NBFLeeway is clock-skew for nbf only (ADV-017). Zero uses
	// DefaultNBFLeeway (30s). Values above MaxNBFLeeway (60s) are
	// clamped. exp is never given this leeway.
	NBFLeeway time.Duration
}

// Verified is a signature-checked assertion. Host IDs remain untrusted
// until the API resolves the workspace after Verify returns.
type Verified struct {
	Claims Claims
	KeyID  string
	Header header
}

// Verify checks signature (active + overlap), SDK, required claims,
// audience, issuer allowlist, minting-host issuer bind (ADV-023),
// time bounds including nbf, capabilities, and jti eligibility.
// Durable jti consume runs only after those checks succeed so forged
// tokens do not burn ids. Workspace binding is confirmed here only
// when ResolvedWS is already known; exchange verifies first, then
// resolves tenant/workbench, then binds.
func Verify(m Material, token string, opt VerifyOptions) (Verified, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return Verified{}, ErrMissingClaim
	}
	if !m.Ready() {
		return Verified{}, ErrKeyUnavailable
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return Verified{}, ErrSignature
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Verified{}, ErrSignature
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Verified{}, ErrSignature
	}
	sb, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Verified{}, ErrSignature
	}
	var h header
	if err := json.Unmarshal(hb, &h); err != nil {
		return Verified{}, ErrSignature
	}
	if h.Alg != Algorithm || h.Typ != TokenType {
		return Verified{}, ErrSignature
	}
	if strings.TrimSpace(h.SDK) != "" && h.SDK != SDKVersion {
		return Verified{}, ErrSDK
	}
	now := opt.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if !ed25519.Verify(m.Public, []byte(parts[0]+"."+parts[1]), sb) {
		if !verifyOverlap(m, h.Kid, []byte(parts[0]+"."+parts[1]), sb, now) {
			return Verified{}, ErrSignature
		}
	}
	if strings.TrimSpace(h.Kid) != "" && h.Kid != m.KeyID && !overlapHasKid(m, h.Kid, now) {
		return Verified{}, ErrUnknownKey
	}
	var c Claims
	if err := json.Unmarshal(pb, &c); err != nil {
		return Verified{}, ErrMissingClaim
	}
	if err := checkRequired(c); err != nil {
		return Verified{}, err
	}
	if c.SDK != SDKVersion {
		return Verified{}, ErrSDK
	}
	wantAud := strings.TrimSpace(opt.Audience)
	if wantAud == "" {
		wantAud = DefaultAudience
	}
	if c.Audience != wantAud || c.Audience != DefaultAudience {
		return Verified{}, ErrAudience
	}
	if !authz.ValidIssuer(c.Issuer) {
		return Verified{}, ErrIssuer
	}
	allow, err := opt.hostAllowlist(c)
	if err != nil {
		return Verified{}, err
	}
	if err := BindHostIssuer(c.Issuer, c.Host, opt.ExpectedHostIssuer, allow); err != nil {
		return Verified{}, err
	}
	if !authz.ValidSubject(c.Subject) {
		return Verified{}, ErrSubject
	}
	if !authz.ValidUUID(c.TokenID) {
		return Verified{}, ErrTokenID
	}
	if !authz.ValidUUID(c.TenantID) {
		return Verified{}, ErrTenant
	}
	if !authz.ValidWorkbenchKey(c.WorkbenchKey) {
		return Verified{}, ErrWorkbench
	}
	if err := validateCapabilities(c.Capabilities); err != nil {
		return Verified{}, err
	}
	if c.WorkspaceID != "" && !authz.ValidUUID(c.WorkspaceID) {
		return Verified{}, ErrWorkspaceBinding
	}
	// Empty ResolvedWS means the caller has not looked up a workspace
	// yet (ADV-008). Do not treat claim workspace_id as a mismatch.
	if strings.TrimSpace(opt.ResolvedWS) != "" {
		if err := BindVerifiedWorkspace(opt.ResolvedWS, c); err != nil {
			return Verified{}, err
		}
	}
	if nbfNotYetValid(now, c.NotBefore, opt.NBFLeeway) {
		return Verified{}, ErrNotYetValid
	}
	// exp has no clock-skew leeway (ADV-017). Do not reuse nbfNotYetValid.
	if now.Unix() >= c.ExpiresAt {
		return Verified{}, ErrExpired
	}
	if !opt.SkipJTI {
		consumer := opt.Consumer
		if consumer == nil {
			return Verified{}, ErrReplay
		}
		ctx := opt.Context
		if ctx == nil {
			ctx = context.Background()
		}
		if err := consumer.Consume(ctx, c.TokenID, time.Unix(c.ExpiresAt, 0).UTC()); err != nil {
			return Verified{}, err
		}
	}
	kid := strings.TrimSpace(h.Kid)
	if kid == "" {
		kid = m.KeyID
	}
	return Verified{Claims: c, KeyID: kid, Header: h}, nil
}

func (opt VerifyOptions) hostAllowlist(c Claims) ([]string, error) {
	allowCtx, err := ResolveSignedHostContext(c.Ctx, opt.HostContext)
	if err != nil {
		return nil, err
	}
	if opt.SelectPathAllowlist {
		return HostAllowlist(allowCtx, opt.EmbedIssuers, opt.PortalIssuers), nil
	}
	return opt.AllowedIssuers, nil
}

func checkRequired(c Claims) error {
	switch {
	case strings.TrimSpace(c.Issuer) == "":
		return ErrMissingClaim
	case strings.TrimSpace(c.Audience) == "":
		return ErrMissingClaim
	case strings.TrimSpace(c.Subject) == "":
		return ErrMissingClaim
	case c.NotBefore == 0:
		return ErrMissingClaim
	case c.ExpiresAt == 0:
		return ErrMissingClaim
	case strings.TrimSpace(c.TokenID) == "":
		return ErrMissingClaim
	case strings.TrimSpace(c.TenantID) == "":
		return ErrMissingClaim
	case strings.TrimSpace(c.WorkbenchKey) == "":
		return ErrMissingClaim
	case len(c.Capabilities) == 0:
		return ErrMissingClaim
	case strings.TrimSpace(c.SDK) == "":
		return ErrMissingClaim
	}
	return nil
}

func verifyOverlap(m Material, kid string, msg, sig []byte, now time.Time) bool {
	kid = strings.TrimSpace(kid)
	for _, k := range m.Overlap {
		if k.Status != KeyStatusOverlap && k.Status != "" {
			continue
		}
		if !OverlapStillValid(k.OverlapUntil, now) {
			continue
		}
		if kid != "" && k.Kid != kid {
			continue
		}
		pub, err := decodePublicX(k.X)
		if err != nil {
			continue
		}
		if ed25519.Verify(pub, msg, sig) {
			return true
		}
	}
	return false
}

func overlapHasKid(m Material, kid string, now time.Time) bool {
	for _, k := range m.Overlap {
		if k.Kid == kid && k.Status == KeyStatusOverlap && OverlapStillValid(k.OverlapUntil, now) {
			return true
		}
	}
	return false
}
