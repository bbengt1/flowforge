package oidchttp

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
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
func postOIDCStart(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !s.RequireStore(w, r) || !s.RequireSessions(w, r) {
		return
	}
	if s.OIDC == nil || !s.OIDC.Ready() {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "OIDC is not configured.")
		return
	}
	ok, retry, err := allowOIDC(s, r)
	if err != nil {
		core.WriteRateStoreUnavailable(w, r)
		return
	}
	if !ok {
		s.AuditLoginRejected(r, "rate-limited")
		core.WriteRateLimited(w, r, retry, "Login rate limit exceeded. Retry after the configured window.")
		return
	}
	if !decodeOIDCStart(w, r) {
		return
	}
	started, err := s.OIDC.Start(r.Context())
	if err != nil {
		writeOIDCError(s, w, r, err)
		return
	}
	setOIDCStateCookie(s, w, r, started.State, started.ExpiresAt)
	core.WriteJSON(w, http.StatusOK, map[string]any{
		"authorization_url": started.AuthorizationURL,
		"state":             started.State,
		"expires_at":        started.ExpiresAt,
	})
}

// postOIDCCallback completes PKCE and mints the same ff_session / ff_csrf
// pair as local login. It does not accept client_secret or code_verifier.
func postOIDCCallback(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !s.RequireStore(w, r) || !s.RequireSessions(w, r) {
		return
	}
	if s.OIDC == nil || !s.OIDC.Ready() {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "OIDC is not configured.")
		return
	}
	allowed, retry, rateErr := allowOIDC(s, r)
	if rateErr != nil {
		core.WriteRateStoreUnavailable(w, r)
		return
	}
	if !allowed {
		s.AuditLoginRejected(r, "rate-limited")
		core.WriteRateLimited(w, r, retry, "Login rate limit exceeded. Retry after the configured window.")
		return
	}
	in, ok := decodeOIDCCallback(w, r)
	if !ok {
		return
	}
	if !oidcStateCookieMatches(r, in.State) {
		clearOIDCStateCookie(s, w, r)
		s.AuditLoginRejected(r, "oidc state mismatch")
		core.WriteProblem(w, r, http.StatusUnauthorized, core.CodeUnauthenticated, "Unauthenticated", core.InvalidCredentialsDetail)
		return
	}
	ident, err := s.OIDC.Complete(r.Context(), in.Code, in.State)
	clearOIDCStateCookie(s, w, r)
	if err != nil {
		s.AuditLoginRejected(r, "oidc rejected")
		writeOIDCError(s, w, r, err)
		return
	}
	user, err := s.Store.UpsertUser(r.Context(), ident.Issuer, ident.Subject, ident.DisplayName)
	if err != nil {
		core.WriteIdentityError(w, r, err)
		return
	}
	if user.Status != "active" {
		s.AuditLoginRejected(r, "oidc rejected")
		core.WriteProblem(w, r, http.StatusUnauthorized, core.CodeUnauthenticated, "Unauthenticated", core.InvalidCredentialsDetail)
		return
	}
	locked, ok := s.AccountLocked(w, r, user.ID)
	if !ok {
		return
	}
	if locked {
		s.AuditLoginRejected(r, "account locked")
		core.WriteProblem(w, r, http.StatusUnauthorized, core.CodeUnauthenticated, "Unauthenticated", core.InvalidCredentialsDetail)
		return
	}
	if !s.ClearAccountFailures(w, r, user.ID) {
		return
	}
	s.MintStandaloneSession(w, r, user, "oidc")
}

func allowOIDC(s *core.Server, r *http.Request) (bool, time.Duration, error) {
	if s.LoginLimiter == nil {
		return false, time.Minute, nil
	}
	return s.LoginLimiter.Decide(r.Context(), "oidc:"+s.RequestClientIP(r), oidcRatePerIP, s.ClockNow())
}

func writeOIDCError(s *core.Server, w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, oidc.ErrNotConfigured):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "OIDC is not configured.")
	case errors.Is(err, oidc.ErrUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Identity provider is not available.")
	default:
		core.WriteProblem(w, r, http.StatusUnauthorized, core.CodeUnauthenticated, "Unauthenticated", core.InvalidCredentialsDetail)
	}
}

func decodeOIDCStart(w http.ResponseWriter, r *http.Request) bool {
	if r.Body == nil || r.ContentLength == 0 && strings.TrimSpace(r.Header.Get("Content-Type")) == "" {
		return true
	}
	var raw map[string]any
	if !core.DecodeJSON(w, r, &raw) {
		return false
	}
	if len(raw) != 0 {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "OIDC start takes an empty object.")
		return false
	}
	return true
}

func decodeOIDCCallback(w http.ResponseWriter, r *http.Request) (oidcCallbackRequest, bool) {
	var raw map[string]any
	if !core.DecodeJSON(w, r, &raw) {
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
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "OIDC callback accepts code and state.")
			return oidcCallbackRequest{}, false
		}
	}
	if strings.TrimSpace(code) == "" || strings.TrimSpace(state) == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "code and state are required.")
		return oidcCallbackRequest{}, false
	}
	return oidcCallbackRequest{Code: code, State: state}, true
}

func setOIDCStateCookie(s *core.Server, w http.ResponseWriter, r *http.Request, state string, exp time.Time) {
	maxAge := int(exp.Sub(s.ClockNow()).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	core.WriteCookie(w, http.Cookie{
		Name:     oidc.StateCookie,
		Value:    state,
		Path:     session.CookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	}, core.RequestCookieSecure(s.Sec, r))
}

func clearOIDCStateCookie(s *core.Server, w http.ResponseWriter, r *http.Request) {
	core.WriteCookie(w, http.Cookie{
		Name:     oidc.StateCookie,
		Value:    "",
		Path:     session.CookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	}, core.RequestCookieSecure(s.Sec, r))
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
