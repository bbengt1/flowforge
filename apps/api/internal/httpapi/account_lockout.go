package httpapi

import (
	"net/http"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/lockout"
)

// Durable account lockout applies to local login and OIDC sign-in.
// The counter lives in the lockout store (Postgres in production), so a
// process restart does not clear it. Unlock is platform.administer on a
// non-embed session. Responses never include passwords or hashes.

func (s *Server) accountLocked(w http.ResponseWriter, r *http.Request, userID string) (bool, bool) {
	if !s.lockoutReady(w, r) {
		return false, false
	}
	st, err := s.lockouts.Get(r.Context(), userID)
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return false, false
	}
	return st.Locked(), true
}

func (s *Server) noteAccountFailure(w http.ResponseWriter, r *http.Request, userID string) bool {
	if !s.lockoutReady(w, r) {
		return false
	}
	if _, err := s.lockouts.NoteFailure(r.Context(), userID, s.lockoutMax, s.clockNow()); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return false
	}
	return true
}

func (s *Server) clearAccountFailures(w http.ResponseWriter, r *http.Request, userID string) bool {
	if !s.lockoutReady(w, r) {
		return false
	}
	if err := s.lockouts.Clear(r.Context(), userID); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return false
	}
	return true
}

func (s *Server) lockoutReady(w http.ResponseWriter, r *http.Request) bool {
	if s.lockouts == nil || s.lockoutMax < lockout.MinMaxFailures || s.lockoutMax > lockout.MaxMaxFailures {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Account lockout is not configured.")
		return false
	}
	return true
}

func (s *Server) getAccountLockout(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) {
		return
	}
	caller, ok := s.requirePrincipal(w, r)
	if !ok || !s.allowAccountAdmin(w, r, caller) || !s.lockoutReady(w, r) {
		return
	}
	target, err := s.store.GetUser(r.Context(), r.PathValue("userID"))
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	st, err := s.lockouts.Get(r.Context(), target.ID)
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return
	}
	writeJSON(w, http.StatusOK, lockoutView(st))
}

func (s *Server) postAccountUnlock(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) {
		return
	}
	caller, ok := s.requirePrincipal(w, r)
	if !ok || !s.allowAccountAdmin(w, r, caller) || !s.lockoutReady(w, r) {
		return
	}
	target, err := s.store.GetUser(r.Context(), r.PathValue("userID"))
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if err := s.lockouts.Unlock(r.Context(), target.ID); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":      target.ID,
		"locked":       false,
		"failed_count": 0,
	})
}

func (s *Server) allowAccountAdmin(w http.ResponseWriter, r *http.Request, user identity.User) bool {
	if embedSessionBound(r) {
		WriteForbidden(w, r)
		return false
	}
	return s.requirePlatformAdmin(w, r, user)
}

func lockoutView(st lockout.State) map[string]any {
	body := map[string]any{
		"user_id":      st.UserID,
		"locked":       st.Locked(),
		"failed_count": st.Failed,
	}
	if st.LockedAt != nil {
		body["locked_at"] = st.LockedAt.UTC().Format(time.RFC3339)
	}
	return body
}
