package httpapi

import (
	"errors"
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
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
