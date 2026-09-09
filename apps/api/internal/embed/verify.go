package embed

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// VerifyOptions controls assertion checks. E11.2 will add issuer allowlists
// and durable jti consumption; E11.1 validates the contract and signature.
type VerifyOptions struct {
	Audience   string
	Now        time.Time
	SkipJTI    bool
	Consumer   JTIConsumer
	ResolvedWS string
}

// Verified is a signature-checked assertion. Host IDs remain untrusted
// until the API resolves the workspace.
type Verified struct {
	Claims Claims
	KeyID  string
	Header header
}

// Verify checks signature, SDK, required claims, audience, and time bounds.
// Atomic durable jti consumption is an E11.2 hook (in-process stub here).
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
	if !ed25519.Verify(m.Public, []byte(parts[0]+"."+parts[1]), sb) {
		// E11.2: try overlap kids. E11.1 has none and fails closed.
		if !verifyOverlap(m, h.Kid, []byte(parts[0]+"."+parts[1]), sb) {
			return Verified{}, ErrSignature
		}
	}
	if strings.TrimSpace(h.Kid) != "" && h.Kid != m.KeyID && !overlapHasKid(m, h.Kid) {
		return Verified{}, ErrSignature
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
	if err := authz.ConfirmResolvedID(opt.ResolvedWS, c.WorkspaceID); err != nil {
		return Verified{}, ErrWorkspaceBinding
	}
	now := opt.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if now.Unix() < c.NotBefore {
		return Verified{}, ErrNotYetValid
	}
	if now.Unix() >= c.ExpiresAt {
		return Verified{}, ErrExpired
	}
	if !opt.SkipJTI {
		consumer := opt.Consumer
		if consumer == nil {
			return Verified{}, ErrReplay
		}
		if err := consumer.Consume(c.TokenID, time.Unix(c.ExpiresAt, 0).UTC()); err != nil {
			return Verified{}, err
		}
	}
	return Verified{Claims: c, KeyID: m.KeyID, Header: h}, nil
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

func verifyOverlap(m Material, kid string, msg, sig []byte) bool {
	// E11.2 hook: overlap public keys only. E11.1 returns false.
	_ = kid
	_ = msg
	_ = sig
	if len(m.Overlap) == 0 {
		return false
	}
	return false
}

func overlapHasKid(m Material, kid string) bool {
	for _, k := range m.Overlap {
		if k.Kid == kid && k.Status == KeyStatusOverlap {
			return true
		}
	}
	return false
}
