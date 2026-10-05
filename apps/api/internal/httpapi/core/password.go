package core

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const (
	ChangePasswordReuseDetail = "Choose a new password that is not the one-time default and is not the current password."
	// CurrentPasswordRequiredDetail is the 400 for a voluntary change
	// that omits current_password. It never includes a password.
	CurrentPasswordRequiredDetail = "current_password is required."
	// CurrentPasswordRejectedDetail is the 401 when current_password
	// does not match the stored hash. It never includes a password.
	CurrentPasswordRejectedDetail = "Current password was not accepted."
	changePasswordBodyDetail      = "Change password accepts password or new_password, plus current_password."
)

// postSessionPassword changes the caller's local-login password. CSRF
// is required (session present). Embed sessions are 403 — this is
// standalone local login only. Password POST once; never echoed.
//
// A voluntary change (must_change_password clear) requires
// current_password and verifies it against the stored hash. An
// administrator-initiated reset may omit it. Success replaces the
// hash and clears must_change_password. The retired default admin
// stays the same 401 as unknown.
func (s *Server) postSessionPassword(w http.ResponseWriter, r *http.Request) {
	if !s.RequireStore(w, r) {
		return
	}
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	pc := PrincipalFromRequest(r)
	if pc == nil || pc.Session == nil {
		WriteUnauthenticated(w, r)
		return
	}
	if pc.Session.Binding.Bound() {
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Embed sessions cannot change a local password.")
		return
	}
	password, current, ok := decodeChangePassword(w, r)
	if !ok {
		return
	}
	cred, err := s.Store.LookupLocalLoginByUser(r.Context(), user.ID)
	if err != nil {
		WriteLocalPasswordError(w, r, err)
		return
	}
	if !cred.MustChangePassword && current == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", CurrentPasswordRequiredDetail)
		return
	}
	if current != "" && !localauth.Verify(current, cred.PasswordHash) {
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", CurrentPasswordRejectedDetail)
		return
	}
	if localauth.Verify(password, cred.PasswordHash) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", ChangePasswordReuseDetail)
		return
	}
	if err := localauth.ValidateReplacementPassword(password, ""); err != nil {
		WriteLocalPasswordError(w, r, err)
		return
	}
	hash, err := localauth.HashPassword(password)
	if err != nil {
		WriteLocalPasswordError(w, r, err)
		return
	}
	if err := s.Store.ChangeLocalPassword(r.Context(), user.ID, hash); err != nil {
		WriteLocalPasswordError(w, r, err)
		return
	}
	s.AuditSession(r, *pc.Session, session.EventCreated, session.OutcomeAllowed, "password-changed")
	csrf := ""
	if c, err := r.Cookie(session.CSRFCookieName); err == nil && c != nil {
		csrf = c.Value
	}
	WriteJSON(w, http.StatusOK, SessionResponse{
		Session:   s.viewSessionForUser(r.Context(), *pc.Session, user.ID),
		Principal: user,
		CSRFToken: csrf,
	})
}

func decodeChangePassword(w http.ResponseWriter, r *http.Request) (password, current string, ok bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return "", "", false
	}
	var passwordVal any
	var hasPassword bool
	var currentVal any
	var hasCurrent bool
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if loginBodyForbidden(norm) || changePasswordBodyForbidden(norm) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", changePasswordBodyDetail)
			return "", "", false
		}
		switch norm {
		case "password", "new_password":
			if hasPassword && passwordVal != value {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", changePasswordBodyDetail)
				return "", "", false
			}
			passwordVal = value
			hasPassword = true
		case "current_password":
			if hasCurrent && currentVal != value {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", changePasswordBodyDetail)
				return "", "", false
			}
			currentVal = value
			hasCurrent = true
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", changePasswordBodyDetail)
			return "", "", false
		}
	}
	if !hasPassword {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "password is required.")
		return "", "", false
	}
	pass, isStr := passwordVal.(string)
	if !isStr || pass == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "password is required.")
		return "", "", false
	}
	if !hasCurrent {
		return pass, "", true
	}
	cur, isStr := currentVal.(string)
	if !isStr {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", changePasswordBodyDetail)
		return "", "", false
	}
	return pass, cur, true
}

func changePasswordBodyForbidden(key string) bool {
	switch key {
	case "old_password", "identifier", "email", "username":
		return true
	default:
		return false
	}
}
