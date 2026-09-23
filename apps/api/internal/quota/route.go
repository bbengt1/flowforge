package quota

import "strings"

// ClassForRoute maps an HTTP method and path (or mux pattern) onto a
// workspace bucket. Empty means the route is not on the workspace quota.
// Login, embed mint/exchange, machine token, OIDC, portal mint, webhook
// ingress, SCIM, and bootstrap stay off this bucket.
func ClassForRoute(method, path string) string {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = strings.TrimSpace(path)
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	if path == "" || exemptQuota(path) {
		return ""
	}
	if isDownload(method, path) {
		return ClassDownload
	}
	if method == "POST" && strings.HasSuffix(path, "/executions") && strings.Contains(path, "/workflows/") {
		return ClassExecute
	}
	switch method {
	case "POST", "PUT", "PATCH", "DELETE":
		return ClassMutate
	case "GET", "HEAD":
		if expensiveRead(path) {
			return ClassRead
		}
	}
	return ""
}

func exemptQuota(path string) bool {
	switch path {
	case "/api/v1/health", "/api/v1/readiness", "/api/v1/metrics",
		"/api/v1/openapi.yaml", "/api/v1/openapi.json", "/api/v1/swagger",
		"/api/v1/login", "/api/v1/machine/token",
		"/api/v1/permission-matrix", "/api/v1/roles", "/api/v1/permissions":
		return true
	}
	switch {
	case strings.HasPrefix(path, "/api/v1/oidc/"),
		strings.HasPrefix(path, "/api/v1/embed/"),
		strings.HasPrefix(path, "/api/v1/portal/"),
		strings.HasPrefix(path, "/api/v1/hooks/"),
		strings.HasPrefix(path, "/api/v1/bootstrap"),
		strings.HasPrefix(path, "/scim/"):
		return true
	default:
		return false
	}
}

func isDownload(method, path string) bool {
	if method == "POST" && strings.HasSuffix(path, "/downloads") {
		return true
	}
	return strings.Contains(path, "/artifact-downloads/")
}

func expensiveRead(path string) bool {
	if strings.HasSuffix(path, "}") {
		return false
	}
	switch path {
	case "/api/v1/session", "/api/v1/workspace", "/api/v1/session/mfa":
		return false
	}
	if strings.HasSuffix(path, "/catalog") || strings.HasSuffix(path, "/draft") {
		return false
	}
	return true
}
