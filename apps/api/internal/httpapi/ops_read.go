package httpapi

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

// bearerSessionToken returns the opaque ff_session token from
// Authorization: Bearer, or empty when the header is absent or not Bearer.
// Scrapers use this instead of the HttpOnly cookie.
func bearerSessionToken(r *http.Request) string {
	raw := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if len(raw) < len(prefix) || !strings.EqualFold(raw[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(raw[len(prefix):])
}

func hasOpsReadCredential(r *http.Request) bool {
	if sessionCookieValue(r) != "" || bearerSessionToken(r) != "" {
		return true
	}
	issuer := strings.TrimSpace(r.Header.Get(headerIssuer))
	subject := strings.TrimSpace(r.Header.Get(headerSubject))
	return issuer != "" || subject != ""
}

func (s *Server) requirePrincipalOrBearer(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	if token := sessionCookieValue(r); token != "" {
		return s.requireSessionPrincipal(w, r, token)
	}
	if token := bearerSessionToken(r); token != "" {
		return s.requireSessionPrincipal(w, r, token)
	}
	return s.requireHeaderPrincipal(w, r)
}

// requirePlatformOpsRead gates metrics and OpenAPI/swagger. Callers must
// present an authenticated principal (ff_session cookie, Authorization
// Bearer session token, or trusted-dev identity headers) and hold
// platform.administer via PLATFORM_ADMINS. Missing credentials are 401;
// any other caller (including empty PLATFORM_ADMINS) is 403. Fail closed.
func (s *Server) requirePlatformOpsRead(w http.ResponseWriter, r *http.Request) bool {
	if !hasOpsReadCredential(r) {
		WriteUnauthenticated(w, r)
		return false
	}
	user, ok := s.requirePrincipalOrBearer(w, r)
	if !ok {
		return false
	}
	return s.requirePlatformAdmin(w, r, user)
}
