package httpapi

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/openapi"
	"gopkg.in/yaml.v3"
)

// Server is the versioned control-plane HTTP API.
type Server struct {
	db       postgres.Checker
	log      *slog.Logger
	registry *observability.Registry
}

// New returns a handler for /api/v1 foundation routes.
func New(db postgres.Checker) http.Handler {
	return newServer(db, slog.Default(), observability.NewRegistry())
}

func newServer(db postgres.Checker, log *slog.Logger, registry *observability.Registry) http.Handler {
	if log == nil {
		log = slog.Default()
	}
	if registry == nil {
		registry = observability.NewRegistry()
	}
	s := &Server{db: db, log: log, registry: registry}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("GET /api/v1/readiness", s.readiness)
	mux.HandleFunc("GET /api/v1/metrics", s.metrics)
	mux.HandleFunc("GET /api/v1/openapi.yaml", s.openapiYAML)
	mux.HandleFunc("GET /api/v1/openapi.json", s.openapiJSON)
	mux.HandleFunc("GET /api/v1/swagger", s.swagger)

	router := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rec := muxMethodNotAllowed(mux, r); rec != "" {
			setRoute(r, routePattern(mux, r))
			w.Header().Set("Allow", "GET, HEAD")
			WriteProblem(w, r, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed", rec)
			return
		}
		if !hasExactRoute(mux, r) {
			setRoute(r, "unmatched")
			WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested path does not exist.")
			return
		}
		setRoute(r, routePattern(mux, r))
		mux.ServeHTTP(w, r)
	})

	return withRequestID(withSecureHeaders(withObserve(log, registry, withRecover(log, withBodyLimit(router)))))
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) readiness(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return
	}
	if err := s.db.Ping(r.Context()); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = s.registry.WritePrometheus(w)
}

func (s *Server) openapiYAML(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(mustOpenAPIYAML())
}

func (s *Server) openapiJSON(w http.ResponseWriter, r *http.Request) {
	var doc any
	if err := yaml.Unmarshal(mustOpenAPIYAML(), &doc); err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "OpenAPI document could not be published.")
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) swagger(w http.ResponseWriter, _ *http.Request) {
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

func mustOpenAPIYAML() []byte {
	data, err := fs.ReadFile(openapi.FS, "openapi.yaml")
	if err != nil {
		return []byte("openapi: 3.0.3\ninfo:\n  title: FlowForge Control Plane API\n  version: 0.0.0\n")
	}
	return data
}

func hasExactRoute(mux *http.ServeMux, r *http.Request) bool {
	_, pattern := mux.Handler(r)
	return pattern != ""
}

func routePattern(mux *http.ServeMux, r *http.Request) string {
	if _, pattern := mux.Handler(r); pattern != "" {
		return pattern
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return "unmatched"
	}
	clone := r.Clone(context.Background())
	clone.Method = http.MethodGet
	if _, pattern := mux.Handler(clone); pattern != "" {
		return pattern
	}
	return "unmatched"
}

func muxMethodNotAllowed(mux *http.ServeMux, r *http.Request) string {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return ""
	}
	clone := r.Clone(context.Background())
	clone.Method = http.MethodGet
	if _, pattern := mux.Handler(clone); pattern != "" {
		return "The " + r.Method + " method is not allowed for this path."
	}
	return ""
}

// ReadyChecker adapts a ping function to postgres.Checker.
type ReadyChecker func(ctx context.Context) error

// Ping implements postgres.Checker.
func (f ReadyChecker) Ping(ctx context.Context) error { return f(ctx) }
