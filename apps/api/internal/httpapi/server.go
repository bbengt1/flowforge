package httpapi

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/openapi"
	"gopkg.in/yaml.v3"
)

// Server is the versioned control-plane HTTP API.
type Server struct {
	db        postgres.Checker
	store     identity.Store
	scoped    isolation.Store
	cache     *isolation.Cache
	sessions  session.Store
	workflows wfstore.Store
	log       *slog.Logger
	registry  *observability.Registry
	sec       Security
	clock     func() time.Time
}

// Deps configures a Server. Tests inject stores, security policy, and a clock.
type Deps struct {
	DB        postgres.Checker
	Store     identity.Store
	Scoped    isolation.Store
	Sessions  session.Store
	Workflows wfstore.Store
	Cache     *isolation.Cache
	Log       *slog.Logger
	Registry  *observability.Registry
	Security  Security
	Now       func() time.Time
}

// New returns a handler for /api/v1 foundation routes.
func New(db postgres.Checker) http.Handler {
	return NewWithSecurity(db, Security{})
}

// NewWithSecurity returns a handler with TLS/proxy/CORS/session policy applied.
func NewWithSecurity(db postgres.Checker, sec Security) http.Handler {
	idStore, scoped, sessions, workflows := inferStores(db)
	return NewWithDeps(Deps{
		DB:        db,
		Store:     idStore,
		Scoped:    scoped,
		Sessions:  sessions,
		Workflows: workflows,
		Security:  sec,
	})
}

// NewWithStore returns a handler with an explicit identity store (tests).
func NewWithStore(db postgres.Checker, store identity.Store) http.Handler {
	return NewWithStores(db, store, isolation.NewMemory())
}

// NewWithStores returns a handler with explicit identity and isolation stores.
func NewWithStores(db postgres.Checker, store identity.Store, scoped isolation.Store) http.Handler {
	if scoped == nil {
		scoped = isolation.NewMemory()
	}
	return NewWithDeps(Deps{DB: db, Store: store, Scoped: scoped, Sessions: session.NewMemory(), Workflows: wfstore.NewMemory()})
}

// NewWithDeps returns a handler with explicit dependencies.
func NewWithDeps(d Deps) http.Handler {
	return newServer(d)
}

func inferStores(db postgres.Checker) (identity.Store, isolation.Store, session.Store, wfstore.Store) {
	if p, ok := db.(*postgres.Pool); ok {
		return identity.NewPostgres(p), isolation.NewPostgres(p), session.NewPostgres(p), wfstore.NewPostgres(p)
	}
	return nil, isolation.NewMemory(), session.NewMemory(), wfstore.NewMemory()
}

func newServer(d Deps) http.Handler {
	log := d.Log
	if log == nil {
		log = slog.Default()
	}
	registry := d.Registry
	if registry == nil {
		registry = observability.NewRegistry()
	}
	cache := d.Cache
	if cache == nil {
		cache = isolation.NewCache()
	}
	sessions := d.Sessions
	if sessions == nil {
		sessions = session.NewMemory()
	}
	workflows := d.Workflows
	if workflows == nil {
		workflows = wfstore.NewMemory()
	}
	clock := d.Now
	if clock == nil {
		clock = time.Now
	}
	s := &Server{
		db:        d.DB,
		store:     d.Store,
		scoped:    d.Scoped,
		cache:     cache,
		sessions:  sessions,
		workflows: workflows,
		log:       log,
		registry:  registry,
		sec:       d.Security,
		clock:     clock,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("GET /api/v1/readiness", s.readiness)
	mux.HandleFunc("GET /api/v1/metrics", s.metrics)
	mux.HandleFunc("GET /api/v1/openapi.yaml", s.openapiYAML)
	mux.HandleFunc("GET /api/v1/openapi.json", s.openapiJSON)
	mux.HandleFunc("GET /api/v1/swagger", s.swagger)
	mux.HandleFunc("GET /api/v1/permission-matrix", s.getPermissionMatrix)
	mux.HandleFunc("GET /api/v1/roles", s.getRoles)
	mux.HandleFunc("GET /api/v1/permissions", s.getPermissions)
	mux.HandleFunc("POST /api/v1/tenants", s.createTenant)
	mux.HandleFunc("GET /api/v1/workspaces", s.listWorkspaces)
	mux.HandleFunc("POST /api/v1/workspaces", s.createWorkspace)
	mux.HandleFunc("GET /api/v1/workspace", s.getCurrentWorkspace)
	mux.HandleFunc("GET /api/v1/workspace/members", s.listMembers)
	mux.HandleFunc("PUT /api/v1/workspace/members", s.putMember)
	mux.HandleFunc("DELETE /api/v1/workspace/members/{userID}", s.deleteMember)
	mux.HandleFunc("GET /api/v1/workspace/records", s.listRecords)
	mux.HandleFunc("POST /api/v1/workspace/records", s.createRecord)
	mux.HandleFunc("GET /api/v1/workspace/records/{id}", s.getRecord)
	mux.HandleFunc("POST /api/v1/workspace/records/{id}/links", s.createRecordLink)
	mux.HandleFunc("POST /api/v1/workspace/credentials/{id}/use", s.useCredential)
	mux.HandleFunc("GET /api/v1/workspace/artifacts/{id}", s.getArtifact)
	mux.HandleFunc("GET /api/v1/workspace/jobs", s.listJobs)
	mux.HandleFunc("POST /api/v1/workspace/jobs", s.createJob)
	mux.HandleFunc("GET /api/v1/workspace/cache/{key}", s.getCache)
	mux.HandleFunc("PUT /api/v1/workspace/cache/{key}", s.putCache)
	mux.HandleFunc("POST /api/v1/workspace/realtime/channels/{id}/subscribe", s.subscribeRealtime)
	mux.HandleFunc("GET /api/v1/workspace/audit-events", s.listAuditEvents)
	mux.HandleFunc("POST /api/v1/session", s.createSession)
	mux.HandleFunc("GET /api/v1/session", s.getSession)
	mux.HandleFunc("POST /api/v1/session/refresh", s.refreshSession)
	mux.HandleFunc("POST /api/v1/session/logout", s.logoutSession)
	mux.HandleFunc("GET /api/v1/session/audit-events", s.listSessionAudit)
	mux.HandleFunc("GET /api/v1/workflows/catalog", s.getWorkflowCatalog)
	mux.HandleFunc("POST /api/v1/workflows/validate", s.validateWorkflow)
	mux.HandleFunc("POST /api/v1/workflows/normalize", s.normalizeWorkflow)
	mux.HandleFunc("GET /api/v1/workflows", s.listWorkflows)
	mux.HandleFunc("POST /api/v1/workflows", s.createWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}", s.getWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/draft", s.getWorkflowDraft)
	mux.HandleFunc("PUT /api/v1/workflows/{workflowId}/draft", s.putWorkflowDraft)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/publish", s.publishWorkflow)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/compare", s.compareWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions", s.listWorkflowVersions)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions/{versionId}", s.getWorkflowVersion)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions/{versionId}/export", s.exportWorkflowVersion)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/versions/{versionId}/restore", s.restoreWorkflowVersion)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/executions", s.startWorkflowExecution)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/executions/{executionId}", s.getWorkflowExecution)

	router := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rec, allow := muxMethodNotAllowed(mux, r); rec != "" {
			setRoute(r, routePattern(mux, r))
			w.Header().Set("Allow", allow)
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

	return withRequestID(withSecureHeaders(s.sec, withObserve(log, registry, withRecover(log, withBodyLimit(s.withOriginPolicy(router))))))
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

var routedMethods = []string{
	http.MethodGet, http.MethodHead, http.MethodPost,
	http.MethodPut, http.MethodPatch, http.MethodDelete,
}

func routePattern(mux *http.ServeMux, r *http.Request) string {
	if _, pattern := mux.Handler(r); pattern != "" {
		return pattern
	}
	for _, method := range routedMethods {
		clone := r.Clone(context.Background())
		clone.Method = method
		if _, pattern := mux.Handler(clone); pattern != "" {
			return pattern
		}
	}
	return "unmatched"
}

func allowedMethods(mux *http.ServeMux, r *http.Request) []string {
	seen := map[string]bool{}
	var out []string
	for _, method := range routedMethods {
		clone := r.Clone(context.Background())
		clone.Method = method
		if _, pattern := mux.Handler(clone); pattern != "" && !seen[method] {
			seen[method] = true
			out = append(out, method)
		}
	}
	if seen[http.MethodGet] && !seen[http.MethodHead] {
		// HEAD is conventional for GET-only resources.
		withHead := make([]string, 0, len(out)+1)
		for _, method := range out {
			withHead = append(withHead, method)
			if method == http.MethodGet {
				withHead = append(withHead, http.MethodHead)
			}
		}
		out = withHead
	}
	return out
}

func muxMethodNotAllowed(mux *http.ServeMux, r *http.Request) (string, string) {
	if hasExactRoute(mux, r) {
		return "", ""
	}
	allowed := allowedMethods(mux, r)
	if len(allowed) == 0 {
		return "", ""
	}
	return "The " + r.Method + " method is not allowed for this path.", strings.Join(allowed, ", ")
}

// ReadyChecker adapts a ping function to postgres.Checker.
type ReadyChecker func(ctx context.Context) error

// Ping implements postgres.Checker.
func (f ReadyChecker) Ping(ctx context.Context) error { return f(ctx) }
