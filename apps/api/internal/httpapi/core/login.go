package core

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const InvalidCredentialsDetail = "Invalid credentials."

// postLogin is V.0a standalone local sign-in. It verifies email or
// username + password and mints the same ff_session / ff_csrf pair as
// trusted-dev POST /session (standalone Lax; Path=/api/v1). GET /session
// after success is a normal non-embed session.
//
// CSRF is not required (no session yet), matching POST /embed/exchange
// and trusted-dev POST /session. Password is POST-once and never echoed.
// Bad password and unknown identifier are the same 401. Rate-limited
// by IP and identifier before lookup/bcrypt (429 + Retry-After).
// Durable lockout (auth_lockouts) is separate from that window: a
// locked account is the same 401 after a correct password and survives
// process restart. Store failures other than unknown identifier are 503.
//
// OIDC Authorization Code + PKCE is POST /oidc/start and POST /oidc/callback.
// This handler stays the local password door. Do not fold IdP exchange
// or MFA into it. Embed stays POST /embed/exchange only.
func (s *Server) postLogin(w http.ResponseWriter, r *http.Request) {
	if !s.RequireStore(w, r) || !s.RequireSessions(w, r) {
		return
	}
	identifier, password, ok := decodeLocalLogin(w, r)
	if !ok {
		return
	}
	ok, retry, err := s.AllowLogin(r, identifier)
	if err != nil {
		WriteRateStoreUnavailable(w, r)
		return
	}
	if !ok {
		s.AuditLoginRejected(r, "rate-limited")
		WriteRateLimited(w, r, retry, "Login rate limit exceeded. Retry after the configured window.")
		return
	}
	cred, err := s.Store.LookupLocalLogin(r.Context(), identifier)
	if err != nil {
		if !errors.Is(err, identity.ErrNotFound) {
			if s.Log != nil {
				s.Log.Error("local_login_lookup",
					"request_id", RequestIDFromContext(r.Context()),
					"error", err.Error(),
				)
			}
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
			return
		}
		localauth.DummyVerify(password)
		s.AuditLoginRejected(r, "invalid credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", InvalidCredentialsDetail)
		return
	}
	verified := localauth.Verify(password, cred.PasswordHash)
	if cred.User.Status != "active" {
		s.AuditLoginRejected(r, "invalid credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", InvalidCredentialsDetail)
		return
	}
	locked, ok := s.AccountLocked(w, r, cred.User.ID)
	if !ok {
		return
	}
	if !verified {
		if !s.noteAccountFailure(w, r, cred.User.ID) {
			return
		}
		s.AuditLoginRejected(r, "invalid credentials")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", InvalidCredentialsDetail)
		return
	}
	if locked {
		s.AuditLoginRejected(r, "account locked")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", InvalidCredentialsDetail)
		return
	}
	if !s.ClearAccountFailures(w, r, cred.User.ID) {
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

func (s *Server) AllowLogin(r *http.Request, identifier string) (bool, time.Duration, error) {
	if s.LoginLimiter == nil {
		return false, localauth.DefaultRateWindow, nil
	}
	now := s.ClockNow()
	ok, retry, err := s.LoginLimiter.Decide(r.Context(), localauth.IPKey(s.RequestClientIP(r)), s.LoginLimits.PerIP, now)
	if err != nil || !ok {
		return ok, retry, err
	}
	return s.LoginLimiter.Decide(r.Context(), localauth.IdentifierKey(identifier), s.LoginLimits.Identifier, now)
}

func (s *Server) AuditLoginRejected(r *http.Request, reason string) {
	if s.Sessions == nil {
		return
	}
	event := session.AuditEvent{
		EventType: session.EventAuthRejected,
		Outcome:   session.OutcomeDenied,
		Reason:    reason,
		RequestID: RequestIDFromContext(r.Context()),
		CreatedAt: s.ClockNow(),
	}
	if err := s.Sessions.Audit(r.Context(), event); err != nil && s.Log != nil {
		s.Log.Error("session_audit_persist",
			"request_id", event.RequestID,
			"error", err.Error(),
		)
	}
	if s.Log != nil {
		s.Log.Info("session_audit",
			"request_id", event.RequestID,
			"event_type", event.EventType,
			"outcome", event.Outcome,
			"reason", reason,
		)
	}
}

func WriteLocalPasswordError(w http.ResponseWriter, r *http.Request, err error) {
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
