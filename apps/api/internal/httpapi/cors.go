package httpapi

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const corsAllowHeaders = "Content-Type, X-CSRF-Token, X-Request-ID, X-FlowForge-Issuer, X-FlowForge-Subject, X-FlowForge-Display-Name, X-FlowForge-Tenant-ID, X-FlowForge-Tenant-Slug, X-FlowForge-Workbench-Key, X-FlowForge-Workspace-ID"
const corsAllowMethods = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"

func (s Security) classifyOrigin(r *http.Request) (allowed bool, emitCORS bool, origin string) {
	origin = strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true, false, ""
	}
	if origin == "null" || origin == "*" {
		return false, false, origin
	}
	if s.sameOrigin(r, origin) {
		return true, false, origin
	}
	for _, allowedOrigin := range s.AllowedOrigins {
		if origin == allowedOrigin {
			return true, true, origin
		}
	}
	return false, false, origin
}

func (s Security) sameOrigin(r *http.Request, origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return false
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	scheme := "http"
	if s.requestIsHTTPS(r) {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = r.URL.Host
	}
	return strings.EqualFold(u.Scheme, scheme) && strings.EqualFold(normalizeHost(u.Host, u.Scheme), normalizeHost(host, scheme))
}

func normalizeHost(host, scheme string) string {
	h, port, err := net.SplitHostPort(host)
	if err != nil {
		return strings.ToLower(host)
	}
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		return strings.ToLower(h)
	}
	return strings.ToLower(h) + ":" + port
}

func writeCORSHeaders(w http.ResponseWriter, origin string) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Access-Control-Allow-Credentials", "true")
	h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
	h.Set("Access-Control-Allow-Methods", corsAllowMethods)
	h.Set("Access-Control-Expose-Headers", RequestIDHeader)
	h.Set("Access-Control-Max-Age", "600")
	h.Add("Vary", "Origin")
}

func (s *Server) withOriginPolicy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed, emitCORS, origin := s.sec.classifyOrigin(r)
		if !allowed {
			s.auditSession(r, session.Record{}, session.EventOriginRejected, session.OutcomeDenied, "hostile origin")
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Origin is not allowed.")
			return
		}
		if emitCORS {
			writeCORSHeaders(w, origin)
		}
		if r.Method == http.MethodOptions && origin != "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
