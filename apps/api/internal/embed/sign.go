package embed

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// MintInput is the host-backend mint request after HTTP decoding.
type MintInput struct {
	Issuer       string
	Subject      string
	DisplayName  string
	Host         string
	TenantID     string
	WorkbenchKey string
	WorkspaceID  string
	Capabilities []string
	TTL          time.Duration
	Audience     string
	Now          time.Time
}

// header is the JWS protected header. kid identifies the active key.
type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid"`
	SDK string `json:"sdk"`
}

// Sign compact-serializes and Ed25519-signs claims. The private key is
// never written into the token or returned alongside it.
func Sign(m Material, c Claims) (string, error) {
	if !m.Ready() {
		return "", ErrKeyUnavailable
	}
	if err := validateClaimsShape(c); err != nil {
		return "", err
	}
	h := header{Alg: Algorithm, Typ: TokenType, Kid: m.KeyID, SDK: SDKVersion}
	hb, err := json.Marshal(h)
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	input := b64(hb) + "." + b64(pb)
	sig := ed25519.Sign(m.Private, []byte(input))
	return input + "." + b64(sig), nil
}

// Mint builds short-lived claims and signs them.
func Mint(m Material, in MintInput) (Minted, Claims, error) {
	if !m.Ready() {
		return Minted{}, Claims{}, ErrKeyUnavailable
	}
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	ttl := in.TTL
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if ttl < MinTTL || ttl > MaxTTL {
		return Minted{}, Claims{}, ErrTTL
	}
	aud := strings.TrimSpace(in.Audience)
	if aud == "" {
		aud = DefaultAudience
	}
	if aud != DefaultAudience {
		return Minted{}, Claims{}, ErrAudience
	}
	iss := strings.TrimSpace(in.Issuer)
	sub := strings.TrimSpace(in.Subject)
	if !authz.ValidIssuer(iss) {
		return Minted{}, Claims{}, ErrIssuer
	}
	if !authz.ValidSubject(sub) {
		return Minted{}, Claims{}, ErrSubject
	}
	if !authz.ValidUUID(strings.TrimSpace(in.TenantID)) {
		return Minted{}, Claims{}, ErrTenant
	}
	if !authz.ValidWorkbenchKey(strings.TrimSpace(in.WorkbenchKey)) {
		return Minted{}, Claims{}, ErrWorkbench
	}
	if err := validateCapabilities(in.Capabilities); err != nil {
		return Minted{}, Claims{}, err
	}
	ws := strings.TrimSpace(in.WorkspaceID)
	if ws != "" && !authz.ValidUUID(ws) {
		return Minted{}, Claims{}, ErrWorkspaceBinding
	}
	jti, err := newTokenID()
	if err != nil {
		return Minted{}, Claims{}, err
	}
	c := Claims{
		Issuer:       iss,
		Audience:     aud,
		Subject:      sub,
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(ttl).Unix(),
		TokenID:      jti,
		TenantID:     strings.TrimSpace(in.TenantID),
		WorkbenchKey: strings.TrimSpace(in.WorkbenchKey),
		WorkspaceID:  ws,
		Capabilities: append([]string(nil), in.Capabilities...),
		SDK:          SDKVersion,
		DisplayName:  strings.TrimSpace(in.DisplayName),
		Host:         strings.TrimSpace(in.Host),
	}
	token, err := Sign(m, c)
	if err != nil {
		return Minted{}, Claims{}, err
	}
	view := PublicViewFromClaims(c, m.KeyID)
	return Minted{PublicView: view, Assertion: token}, c, nil
}

func newTokenID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("token id: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

func b64(p []byte) string {
	return base64.RawURLEncoding.EncodeToString(p)
}

func validateCapabilities(caps []string) error {
	if len(caps) == 0 {
		return ErrCapability
	}
	seen := map[string]struct{}{}
	for _, c := range caps {
		c = strings.TrimSpace(c)
		if c == "" || !authz.Known(c) {
			return ErrCapability
		}
		if _, ok := seen[c]; ok {
			return ErrCapability
		}
		seen[c] = struct{}{}
	}
	return nil
}

func validateClaimsShape(c Claims) error {
	if strings.TrimSpace(c.Issuer) == "" || strings.TrimSpace(c.Subject) == "" {
		return ErrMissingClaim
	}
	if strings.TrimSpace(c.Audience) == "" {
		return ErrMissingClaim
	}
	if strings.TrimSpace(c.TokenID) == "" {
		return ErrMissingClaim
	}
	if c.NotBefore == 0 || c.ExpiresAt == 0 {
		return ErrMissingClaim
	}
	if strings.TrimSpace(c.TenantID) == "" || strings.TrimSpace(c.WorkbenchKey) == "" {
		return ErrMissingClaim
	}
	if len(c.Capabilities) == 0 {
		return ErrMissingClaim
	}
	if strings.TrimSpace(c.SDK) == "" {
		return ErrMissingClaim
	}
	return nil
}
