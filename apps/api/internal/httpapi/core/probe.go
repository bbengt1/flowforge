package core

import (
	"bytes"
	"io/fs"
	"net/http"

	"gopkg.in/yaml.v3"

	"github.com/bbengt1/flowforge/apps/api/internal/buildinfo"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/openapi"
)

func (s *Server) Health(w http.ResponseWriter, _ *http.Request) {
	// Unlimited. Workspace quotas and auth-door limits do not apply.
	WriteJSON(w, http.StatusOK, probeIdentity("ok"))
}

func (s *Server) Readiness(w http.ResponseWriter, r *http.Request) {
	if s.DB == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return
	}
	if err := s.DB.Ping(r.Context()); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return
	}
	WriteJSON(w, http.StatusOK, probeIdentity("ready"))
}

// probeIdentity is the secret-free liveness/readiness body. version/sha
// come from ldflags or BUILD_* env; unsafe values become "dev"/"unknown"
// and never change the probe status.
func probeIdentity(status string) map[string]string {
	info := buildinfo.Resolve()
	return map[string]string{
		"status":  status,
		"version": info.Version,
		"sha":     info.SHA,
	}
}

func (s *Server) Metrics(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
	var buf bytes.Buffer
	if err := s.Registry.WritePrometheus(&buf); err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "Metrics could not be published.")
		return
	}
	if err := observability.WriteOTelPrometheus(&buf); err != nil && s.Log != nil {
		s.Log.Error("opentelemetry metrics", "error", err)
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) openapiYAML(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/yaml")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(MustOpenAPIYAML())
}

func (s *Server) openapiJSON(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
	var doc any
	if err := yaml.Unmarshal(MustOpenAPIYAML(), &doc); err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "OpenAPI document could not be published.")
		return
	}
	WriteJSON(w, http.StatusOK, doc)
}

func (s *Server) Swagger(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(swaggerHTML))
}

const swaggerHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FlowForge API</title>
</head>
<body>
  <h1>FlowForge Control Plane API</h1>
  <p>Published specification:</p>
  <ul>
    <li><a href="/api/v1/openapi.yaml">OpenAPI YAML</a></li>
    <li><a href="/api/v1/openapi.json">OpenAPI JSON</a></li>
  </ul>
</body>
</html>
`

func MustOpenAPIYAML() []byte {
	data, err := fs.ReadFile(openapi.FS, "openapi.yaml")
	if err != nil {
		return []byte("openapi: 3.0.3\ninfo:\n  title: FlowForge Control Plane API\n  version: 0.0.0\n")
	}
	return data
}
