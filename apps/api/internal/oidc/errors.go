// Package oidc is the enterprise Authorization Code + PKCE door.
//
// It is not local login, not trusted-dev header identity, not the
// machine principal, and not POST /embed/exchange. A successful
// callback mints the same ff_session / ff_csrf pair humans already use.
// client_secret and the PKCE verifier stay on the server.
package oidc

import "errors"

// Sentinel errors. Text is safe to log: it never includes secrets,
// authorization codes, or tokens.
var (
	ErrNotConfigured = errors.New("oidc is not configured")
	ErrRejected      = errors.New("oidc authentication rejected")
	ErrUnavailable   = errors.New("oidc provider unavailable")
	ErrInvalid       = errors.New("invalid oidc request")
)
