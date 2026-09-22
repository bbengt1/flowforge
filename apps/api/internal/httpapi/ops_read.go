package httpapi

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
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
// platform.administer or an explicit machine grant of ops.metrics.read.
// Missing credentials are 401. Any other caller is 403. When
// MACHINE_REQUIRE includes metrics, a missing, revoked, or ungranted
// principal fails closed with 503 before the scrape is served.
func (s *Server) requirePlatformOpsRead(w http.ResponseWriter, r *http.Request) bool {
	if !hasOpsReadCredential(r) {
		WriteUnauthenticated(w, r)
		return false
	}
	user, ok := s.requirePrincipalOrBearer(w, r)
	if !ok {
		return false
	}
	if s.machineConsumers.Requires(machine.ConsumerMetrics) {
		if err := machine.CheckConsumer(r.Context(), s.machines, s.machineConsumers, machine.ConsumerMetrics); err != nil {
			if s.log != nil {
				s.log.Error("machine_consumer",
					"request_id", RequestIDFromContext(r.Context()),
					"consumer", machine.ConsumerMetrics,
					"error", err.Error(),
				)
			}
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Machine principal for metrics is not configured.")
			return false
		}
	}
	if s.allowOpsRead(r, user) {
		if authz.IsPlatformAdmin(user.Issuer, user.ExternalSubject, s.platformAdmins) {
			return s.allowMFAGrant(w, r, authz.PermPlatformAdminister)
		}
		return true
	}
	if pc := principalFromRequest(r); pc != nil && pc.session != nil {
		s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "missing ops read")
	}
	WriteForbidden(w, r)
	return false
}

func (s *Server) allowOpsRead(r *http.Request, user identity.User) bool {
	if authz.IsPlatformAdmin(user.Issuer, user.ExternalSubject, s.platformAdmins) {
		return true
	}
	return s.machineAllows(r, user, authz.PermOpsMetricsRead) || s.machineAllows(r, user, authz.PermPlatformAdminister)
}
