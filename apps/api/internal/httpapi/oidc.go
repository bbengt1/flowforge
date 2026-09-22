package httpapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/oidc"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const oidcRatePerIP = 30

type oidcCallbackRequest struct {
	Code  string
	State string
}

// postOIDCStart begins Authorization Code + PKCE. No session and no
// CSRF (there is no ff_session yet). The response is the authorize URL
// and state. The PKCE verifier and client_secret stay on the server.
// A browser-bound ff_oidc_state cookie binds this start to the callback.
func (s *Server) postOIDCStart(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) || !s.requireSessions(w, r) {
		return
	}
	if s.oidc == nil || !s.oidc.Ready() {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "OIDC is not configured.")
		return
	}
	if !s.allowOIDC(r) {
		s.auditLoginRejected(r, "rate-limited")
		s.writeLoginRateLimited(w, r)
		return
	}
	if !decodeOIDCStart(w, r) {
		return
	}
	started, err := s.oidc.Start(r.Context())
	if err != nil {
		s.writeOIDCError(w, r, err)
		return
	}
	s.setOIDCStateCookie(w, r, started.State, started.ExpiresAt)
	writeJSON(w, http.StatusOK, map[string]any{
		"authorization_url": started.AuthorizationURL,
		"state":             started.State,
		"expires_at":        started.ExpiresAt,
	})
}

// postOIDCCallback completes PKCE and mints the same ff_session / ff_csrf
// pair as local login. It does not accept client_secret or code_verifier.
func (s *Server) postOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) || !s.requireSessions(w, r) {
		return
	}
	if s.oidc == nil || !s.oidc.Ready() {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "OIDC is not configured.")
		return
	}
	if !s.allowOIDC(r) {
		s.auditLoginRejected(r, "rate-limited")
		s.writeLoginRateLimited(w, r)
		return
	}
	in, ok := decodeOIDCCallback(w, r)
	if !ok {
		return
	}
	if !oidcStateCookieMatches(r, in.State) {
		s.clearOIDCStateCookie(w, r)
		s.auditLoginRejected(r, "oidc state mismatch")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	ident, err := s.oidc.Complete(r.Context(), in.Code, in.State)
	s.clearOIDCStateCookie(w, r)
	if err != nil {
		s.auditLoginRejected(r, "oidc rejected")
		s.writeOIDCError(w, r, err)
		return
	}
	user, err := s.store.UpsertUser(r.Context(), ident.Issuer, ident.Subject, ident.DisplayName)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if user.Status != "active" {
		s.auditLoginRejected(r, "oidc rejected")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	locked, ok := s.accountLocked(w, r, user.ID)
	if !ok {
		return
	}
	if locked {
		s.auditLoginRejected(r, "account locked")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	if !s.clearAccountFailures(w, r, user.ID) {
		return
	}
	s.mintStandaloneSession(w, r, user, "oidc")
}

func (s *Server) allowOIDC(r *http.Request) bool {
	if s.loginLimiter == nil {
		return false
	}
	return s.loginLimiter.Allow("oidc:"+s.requestClientIP(r), oidcRatePerIP, s.clockNow())
}

func (s *Server) writeOIDCError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, oidc.ErrNotConfigured):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "OIDC is not configured.")
	case errors.Is(err, oidc.ErrUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity provider is not available.")
	default:
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
	}
}

func decodeOIDCStart(w http.ResponseWriter, r *http.Request) bool {
	if r.Body == nil || r.ContentLength == 0 && strings.TrimSpace(r.Header.Get("Content-Type")) == "" {
		return true
	}
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return false
	}
	if len(raw) != 0 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "OIDC start takes an empty object.")
		return false
	}
	return true
}

func decodeOIDCCallback(w http.ResponseWriter, r *http.Request) (oidcCallbackRequest, bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return oidcCallbackRequest{}, false
	}
	var code, state string
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		switch norm {
		case "code":
			code, _ = value.(string)
		case "state":
			state, _ = value.(string)
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "OIDC callback accepts code and state.")
			return oidcCallbackRequest{}, false
		}
	}
	if strings.TrimSpace(code) == "" || strings.TrimSpace(state) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "code and state are required.")
		return oidcCallbackRequest{}, false
	}
	return oidcCallbackRequest{Code: code, State: state}, true
}

func (s *Server) setOIDCStateCookie(w http.ResponseWriter, r *http.Request, state string, exp time.Time) {
	maxAge := int(exp.Sub(s.clockNow()).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	https := s.sec.requestIsHTTPS(r)
	http.SetCookie(w, &http.Cookie{
		Name:     oidc.StateCookie,
		Value:    state,
		Path:     session.CookiePath,
		HttpOnly: true,
		Secure:   https,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	})
}

func (s *Server) clearOIDCStateCookie(w http.ResponseWriter, r *http.Request) {
	https := s.sec.requestIsHTTPS(r)
	http.SetCookie(w, &http.Cookie{
		Name:     oidc.StateCookie,
		Value:    "",
		Path:     session.CookiePath,
		HttpOnly: true,
		Secure:   https,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func oidcStateCookieMatches(r *http.Request, state string) bool {
	c, err := r.Cookie(oidc.StateCookie)
	if err != nil || c == nil {
		return false
	}
	got := c.Value
	if len(got) != len(state) || state == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(state)) == 1
}
