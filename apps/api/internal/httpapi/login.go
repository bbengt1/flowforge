package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const invalidCredentialsDetail = "Invalid credentials."

// postLogin is V.0a standalone local sign-in. It verifies email or
// username + password and mints the same ff_session / ff_csrf pair as
// trusted-dev POST /session (standalone Lax; Path=/api/v1). GET /session
// after success is a normal non-embed session.
//
// CSRF is not required (no session yet), matching POST /embed/exchange
// and trusted-dev POST /session. Password is POST-once and never echoed.
// Bad password and unknown identifier are the same 401. Rate-limited
// by IP and identifier before lookup/bcrypt (429 + Retry-After).
// Store failures other than unknown identifier are 503.
//
// OIDC Authorization Code + PKCE is POST /oidc/start and POST /oidc/callback.
// This handler stays the local password door. Do not fold IdP exchange
// or MFA into it. Embed stays POST /embed/exchange only.
func (s *Server) postLogin(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) || !s.requireSessions(w, r) {
		return
	}
	identifier, password, ok := decodeLocalLogin(w, r)
	if !ok {
		return
	}
	if !s.allowLogin(r, identifier) {
		s.auditLoginRejected(r, "rate-limited")
		s.writeLoginRateLimited(w, r)
		return
	}
	cred, err := s.store.LookupLocalLogin(r.Context(), identifier)
	if err != nil {
		if !errors.Is(err, identity.ErrNotFound) {
			if s.log != nil {
				s.log.Error("local_login_lookup",
					"request_id", RequestIDFromContext(r.Context()),
					"error", err.Error(),
				)
			}
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
			return
		}
		localauth.DummyVerify(password)
		s.auditLoginRejected(r, "invalid credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	if cred.User.Status != "active" || !localauth.Verify(password, cred.PasswordHash) {
		s.auditLoginRejected(r, "invalid credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	s.mintStandaloneSessionWithClaim(w, r, cred.User, "local-login", cred.MustChangePassword)
}

func decodeLocalLogin(w http.ResponseWriter, r *http.Request) (identifier, password string, ok bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return "", "", false
	}
	var ident, email, username string
	var hasPassword bool
	var passwordVal any
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if loginBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Login accepts identifier or email or username, plus password.")
			return "", "", false
		}
		switch norm {
		case "identifier":
			ident, _ = value.(string)
		case "email":
			email, _ = value.(string)
		case "username":
			username, _ = value.(string)
		case "password":
			passwordVal = value
			hasPassword = true
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Login accepts identifier or email or username, plus password.")
			return "", "", false
		}
	}
	if !hasPassword {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "identifier and password are required.")
		return "", "", false
	}
	pass, isStr := passwordVal.(string)
	if !isStr || pass == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "identifier and password are required.")
		return "", "", false
	}
	chosen, err := coalesceLoginIdentifier(ident, email, username)
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "identifier and password are required.")
		return "", "", false
	}
	return chosen, pass, true
}

func coalesceLoginIdentifier(identifier, email, username string) (string, error) {
	var seen []string
	for _, raw := range []string{identifier, email, username} {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		norm, err := localauth.NormalizeIdentifier(raw)
		if err != nil {
			return "", err
		}
		seen = append(seen, norm)
	}
	if len(seen) == 0 {
		return "", localauth.ErrInvalidIdentifier
	}
	first := seen[0]
	for _, item := range seen[1:] {
		if item != first {
			return "", localauth.ErrInvalidIdentifier
		}
	}
	return first, nil
}

func loginBodyForbidden(key string) bool {
	switch key {
	case "passwd", "hash", "password_hash", "kek", "secret", "secrets",
		"token", "assertion", "private_key", "privatekey", "ciphertext":
		return true
	default:
		return false
	}
}

func (s *Server) allowLogin(r *http.Request, identifier string) bool {
	if s.loginLimiter == nil {
		return false
	}
	now := s.clockNow()
	if !s.loginLimiter.Allow(localauth.IPKey(s.requestClientIP(r)), s.loginLimits.PerIP, now) {
		return false
	}
	if !s.loginLimiter.Allow(localauth.IdentifierKey(identifier), s.loginLimits.Identifier, now) {
		return false
	}
	return true
}

func (s *Server) writeLoginRateLimited(w http.ResponseWriter, r *http.Request) {
	retry := localauth.DefaultRateWindow
	if s.loginLimiter != nil {
		retry = s.loginLimiter.RetryAfter(s.clockNow())
	}
	writeRateLimited(w, r, retry, "Login rate limit exceeded. Retry after the configured window.")
}

func (s *Server) auditLoginRejected(r *http.Request, reason string) {
	if s.sessions == nil {
		return
	}
	event := session.AuditEvent{
		EventType: session.EventAuthRejected,
		Outcome:   session.OutcomeDenied,
		Reason:    reason,
		RequestID: RequestIDFromContext(r.Context()),
		CreatedAt: s.clockNow(),
	}
	if err := s.sessions.Audit(r.Context(), event); err != nil && s.log != nil {
		s.log.Error("session_audit_persist",
			"request_id", event.RequestID,
			"error", err.Error(),
		)
	}
	if s.log != nil {
		s.log.Info("session_audit",
			"request_id", event.RequestID,
			"event_type", event.EventType,
			"outcome", event.Outcome,
			"reason", reason,
		)
	}
}

func writeLocalPasswordError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, localauth.ErrOneTimePassword), errors.Is(err, localauth.ErrReusedPassword):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Choose a new password that is not the one-time default and is not the current password.")
	case errors.Is(err, localauth.ErrInvalidPassword), errors.Is(err, localauth.ErrInvalidIdentifier), errors.Is(err, identity.ErrInvalid):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Password does not meet the required length.")
	case errors.Is(err, identity.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "That login identifier is already in use.")
	case errors.Is(err, identity.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "No local-login credential is configured for this session.")
	default:
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
	}
}
