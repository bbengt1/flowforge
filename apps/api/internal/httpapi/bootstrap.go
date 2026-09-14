package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func (s *Server) requireBootstrap(w http.ResponseWriter, r *http.Request) bool {
	if s.bootstrap != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap store is not available.")
	return false
}

// getBootstrap returns first-run wizard status. Status only — no secrets,
// no public URL value, no private keys. Auth rule:
//
//   - incomplete: unauthenticated GET is allowed so the standalone wizard
//     can start before any admin or session exists
//   - complete: requires a normal product session (cookie) or trusted-dev
//     identity headers; unauthenticated is 401
//
// This handler must not be used to gate /embed/v1. Embed never shows the
// wizard. standaloneOnly is always true.
func (s *Server) getBootstrap(w http.ResponseWriter, r *http.Request) {
	if !s.requireBootstrap(w, r) {
		return
	}
	st, err := s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		if _, ok := s.requirePrincipal(w, r); !ok {
			return
		}
	}
	writeJSON(w, http.StatusOK, st.Status())
}

// postBootstrapPersistence is wizard step 1 (B.2). It confirms that the
// process DATABASE_URL PostgreSQL is reachable, then sets
// steps.persistence.ready via Store.SetStep. It never marks bootstrap
// complete, never accepts a DSN/password/DATABASE_URL in JSON, and never
// returns secrets.
//
// Auth matches incomplete-install GET /bootstrap: no session is required
// while the gate is incomplete. After complete, this wizard handler
// rejects with 409 (Settings-only). Embed sessions are 403.
func (s *Server) postBootstrapPersistence(w http.ResponseWriter, r *http.Request) {
	if !s.requireBootstrap(w, r) {
		return
	}
	st, err := s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if st.Complete {
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Bootstrap is already complete. Persistence is edited in Settings.")
		return
	}
	if !s.allowIncompleteWizard(w, r) {
		return
	}
	if !s.requirePersistenceReady(w, r) {
		return
	}
	if !decodePersistenceConfirm(w, r) {
		return
	}
	if err := s.bootstrap.SetStep(r.Context(), bootstrap.StepPersistence, true); err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	st, err = s.bootstrap.Get(r.Context())
	if err != nil {
		writeBootstrapError(w, r, err)
		return
	}
	if !st.PersistenceReady || st.Complete {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Persistence is not ready.")
		return
	}
	writeJSON(w, http.StatusOK, st.Status())
}

// allowIncompleteWizard reuses B.1 incomplete openness. A presented
// session cookie is validated (CSRF on POST). Embed-bound sessions are
// forbidden — the wizard is standalone only.
func (s *Server) allowIncompleteWizard(w http.ResponseWriter, r *http.Request) bool {
	if token := sessionCookieValue(r); token != "" {
		if _, ok := s.requireSessionPrincipal(w, r, token); !ok {
			return false
		}
		if embedSessionBound(r) {
			if pc := principalFromRequest(r); pc != nil && pc.session != nil {
				s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "embed session cannot use first-run wizard")
			}
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "The first-run wizard is standalone only.")
			return false
		}
	}
	return true
}

func (s *Server) requirePersistenceReady(w http.ResponseWriter, r *http.Request) bool {
	if s.db == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return false
	}
	if err := s.db.Ping(r.Context()); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return false
	}
	return true
}

func decodePersistenceConfirm(w http.ResponseWriter, r *http.Request) bool {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return false
	}
	for key := range raw {
		if persistenceBodyForbidden(key) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Persistence confirm accepts only confirm:true and never accepts credentials.")
			return false
		}
	}
	if len(raw) != 1 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Persistence confirm accepts only confirm:true and never accepts credentials.")
		return false
	}
	confirm, ok := raw["confirm"].(bool)
	if !ok || !confirm {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "confirm must be true.")
		return false
	}
	return true
}

func persistenceBodyForbidden(key string) bool {
	switch strings.ToLower(strings.ReplaceAll(key, "-", "_")) {
	case "password", "passwd", "dsn", "database_url", "databaseurl",
		"kek", "secret", "secrets", "private_key", "privatekey",
		"pem", "token", "hash", "ciphertext":
		return true
	default:
		return false
	}
}

func writeBootstrapError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, bootstrap.ErrUnavailable) {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap state is not available.")
		return
	}
	if errors.Is(err, bootstrap.ErrInvalid) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The bootstrap request is not valid.")
		return
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Bootstrap state is not available.")
}
