package oidc

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	EnvIssuer       = "OIDC_ISSUER"
	EnvClientID     = "OIDC_CLIENT_ID"
	EnvClientSecret = "OIDC_CLIENT_SECRET"
	EnvRedirectURI  = "OIDC_REDIRECT_URI"
	EnvStateKey     = "OIDC_STATE_KEY"
	EnvScopes       = "OIDC_SCOPES"

	defaultScopes = "openid profile email"
	txnTTL        = 10 * time.Minute
)

// StateCookie binds the browser that called start to the callback.
// It is not the PKCE verifier and not a session.
const StateCookie = "ff_oidc_state"

// Settings is process configuration. ClientSecret and StateKey are
// server-side only and must never be logged or returned.
type Settings struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Scopes       string
	StateKey     []byte
	HTTP         *http.Client
}

// Ready reports whether every required field is present.
func (s Settings) Ready() bool {
	return s.Issuer != "" && s.ClientID != "" && s.ClientSecret != "" &&
		s.RedirectURI != "" && len(s.StateKey) == 32
}

// Load reads OIDC_* from the environment. All empty means OIDC is off
// (routes fail closed when called). Any set field without the rest is
// a boot-fail. production requires https issuer and redirect URI.
// Errors never include secret values.
func Load(production bool) (Settings, error) {
	issuer := strings.TrimSpace(os.Getenv(EnvIssuer))
	clientID := strings.TrimSpace(os.Getenv(EnvClientID))
	secret := strings.TrimSpace(os.Getenv(EnvClientSecret))
	redirect := strings.TrimSpace(os.Getenv(EnvRedirectURI))
	stateRaw := strings.TrimSpace(os.Getenv(EnvStateKey))
	scopes := strings.TrimSpace(os.Getenv(EnvScopes))
	if issuer == "" && clientID == "" && secret == "" && redirect == "" && stateRaw == "" && scopes == "" {
		return Settings{}, nil
	}
	if issuer == "" || clientID == "" || secret == "" || redirect == "" || stateRaw == "" {
		return Settings{}, fmt.Errorf("%s, %s, %s, %s, and %s must be set together",
			EnvIssuer, EnvClientID, EnvClientSecret, EnvRedirectURI, EnvStateKey)
	}
	issuer, err := normalizeIssuer(issuer, production)
	if err != nil {
		return Settings{}, fmt.Errorf("%s: %w", EnvIssuer, err)
	}
	if err := validateClientID(clientID); err != nil {
		return Settings{}, fmt.Errorf("%s: %w", EnvClientID, err)
	}
	if len(secret) < 8 || len(secret) > 512 || hasControl(secret) {
		return Settings{}, fmt.Errorf("%s is malformed", EnvClientSecret)
	}
	redirect, err = normalizeRedirect(redirect, production)
	if err != nil {
		return Settings{}, fmt.Errorf("%s: %w", EnvRedirectURI, err)
	}
	key, err := decodeKey(stateRaw)
	if err != nil {
		return Settings{}, fmt.Errorf("%s: %w", EnvStateKey, err)
	}
	if scopes == "" {
		scopes = defaultScopes
	}
	if !scopeHasOpenID(scopes) {
		return Settings{}, fmt.Errorf("%s must include openid", EnvScopes)
	}
	return Settings{
		Issuer:       issuer,
		ClientID:     clientID,
		ClientSecret: secret,
		RedirectURI:  redirect,
		Scopes:       scopes,
		StateKey:     key,
	}, nil
}

func normalizeIssuer(raw string, production bool) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", ErrInvalid
	}
	if production {
		if u.Scheme != "https" {
			return "", ErrInvalid
		}
	} else if u.Scheme != "https" && u.Scheme != "http" {
		return "", ErrInvalid
	}
	if hasControl(raw) || len(raw) > 512 {
		return "", ErrInvalid
	}
	return raw, nil
}

func normalizeRedirect(raw string, production bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", ErrInvalid
	}
	if u.Scheme != "https" && (production || u.Scheme != "http") {
		return "", ErrInvalid
	}
	if hasControl(raw) || len(raw) > 512 {
		return "", ErrInvalid
	}
	return raw, nil
}

func validateClientID(id string) error {
	if id == "" || len(id) > 256 || hasControl(id) || strings.ContainsAny(id, " /") {
		return ErrInvalid
	}
	return nil
}

func scopeHasOpenID(scopes string) bool {
	for _, part := range strings.Fields(scopes) {
		if part == "openid" {
			return true
		}
	}
	return false
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func decodeKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := hex.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if len(raw) == 32 {
		return []byte(raw), nil
	}
	return nil, ErrInvalid
}
