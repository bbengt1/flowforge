package core

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

func (s *Server) AccountLocked(w http.ResponseWriter, r *http.Request, userID string) (bool, bool) {
	if !s.lockoutReady(w, r) {
		return false, false
	}
	st, err := s.Lockouts.Get(r.Context(), userID)
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
	if _, err := s.Lockouts.NoteFailure(r.Context(), userID, s.LockoutMax, s.ClockNow()); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return false
	}
	return true
}

func (s *Server) ClearAccountFailures(w http.ResponseWriter, r *http.Request, userID string) bool {
	if !s.lockoutReady(w, r) {
		return false
	}
	if err := s.Lockouts.Clear(r.Context(), userID); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return false
	}
	return true
}

func (s *Server) lockoutReady(w http.ResponseWriter, r *http.Request) bool {
	if s.Lockouts == nil || s.LockoutMax < lockout.MinMaxFailures || s.LockoutMax > lockout.MaxMaxFailures {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Account lockout is not configured.")
		return false
	}
	return true
}

func (s *Server) getAccountLockout(w http.ResponseWriter, r *http.Request) {
	if !s.RequireStore(w, r) {
		return
	}
	caller, ok := s.RequirePrincipal(w, r)
	if !ok || !s.allowAccountAdmin(w, r, caller) || !s.lockoutReady(w, r) {
		return
	}
	target, err := s.Store.GetUser(r.Context(), r.PathValue("userID"))
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	st, err := s.Lockouts.Get(r.Context(), target.ID)
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return
	}
	WriteJSON(w, http.StatusOK, lockoutView(st))
}

func (s *Server) postAccountUnlock(w http.ResponseWriter, r *http.Request) {
	if !s.RequireStore(w, r) {
		return
	}
	caller, ok := s.RequirePrincipal(w, r)
	if !ok || !s.allowAccountAdmin(w, r, caller) || !s.lockoutReady(w, r) {
		return
	}
	target, err := s.Store.GetUser(r.Context(), r.PathValue("userID"))
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	if err := s.Lockouts.Unlock(r.Context(), target.ID); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"user_id":      target.ID,
		"locked":       false,
		"failed_count": 0,
	})
}

func (s *Server) allowAccountAdmin(w http.ResponseWriter, r *http.Request, user identity.User) bool {
	if EmbedSessionBound(r) {
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
