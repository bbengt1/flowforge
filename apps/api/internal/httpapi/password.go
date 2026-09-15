package httpapi

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const changePasswordReuseDetail = "Choose a new password that is not the one-time default and is not the current password."

// postSessionPassword is the first-run change-password door. CSRF is
// required (session present). Embed sessions are 403 — this is
// standalone local login only. Password POST once; never echoed.
//
// Success replaces the hash, clears must_change_password, and kills
// the one-time secret so admin/admin is the same 401 as unknown.
func (s *Server) postSessionPassword(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) {
		return
	}
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	pc := principalFromRequest(r)
	if pc == nil || pc.session == nil {
		WriteUnauthenticated(w, r)
		return
	}
	if pc.session.Binding.Bound() {
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Embed sessions cannot change a local password.")
		return
	}
	password, ok := decodeChangePassword(w, r)
	if !ok {
		return
	}
	cred, err := s.store.LookupLocalLoginByUser(r.Context(), user.ID)
	if err != nil {
		writeLocalPasswordError(w, r, err)
		return
	}
	if localauth.Verify(password, cred.PasswordHash) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", changePasswordReuseDetail)
		return
	}
	if err := localauth.ValidateReplacementPassword(password, ""); err != nil {
		writeLocalPasswordError(w, r, err)
		return
	}
	hash, err := localauth.HashPassword(password)
	if err != nil {
		writeLocalPasswordError(w, r, err)
		return
	}
	if err := s.store.ChangeLocalPassword(r.Context(), user.ID, hash); err != nil {
		writeLocalPasswordError(w, r, err)
		return
	}
	s.auditSession(r, *pc.session, session.EventCreated, session.OutcomeAllowed, "password-changed")
	csrf := ""
	if c, err := r.Cookie(session.CSRFCookieName); err == nil && c != nil {
		csrf = c.Value
	}
	writeJSON(w, http.StatusOK, sessionResponse{
		Session:   s.viewSessionForUser(r.Context(), *pc.session, user.ID),
		Principal: user,
		CSRFToken: csrf,
	})
}

func decodeChangePassword(w http.ResponseWriter, r *http.Request) (password string, ok bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return "", false
	}
	var passwordVal any
	var hasPassword bool
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if loginBodyForbidden(norm) || changePasswordBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Change password accepts password or new_password.")
			return "", false
		}
		switch norm {
		case "password", "new_password":
			if hasPassword && passwordVal != value {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Change password accepts password or new_password.")
				return "", false
			}
			passwordVal = value
			hasPassword = true
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Change password accepts password or new_password.")
			return "", false
		}
	}
	if !hasPassword {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "password is required.")
		return "", false
	}
	pass, isStr := passwordVal.(string)
	if !isStr || pass == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "password is required.")
		return "", false
	}
	return pass, true
}

func changePasswordBodyForbidden(key string) bool {
	switch key {
	case "current_password", "old_password", "identifier", "email", "username":
		return true
	default:
		return false
	}
}
