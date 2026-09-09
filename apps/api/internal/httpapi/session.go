package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

type principalContext struct {
	user    identity.User
	session *session.Record
	token   string
}

type createSessionRequest struct {
	Issuer          string `json:"issuer"`
	ExternalSubject string `json:"external_subject"`
	DisplayName     string `json:"display_name"`
}

type sessionView struct {
	ID                string            `json:"id"`
	CreatedAt         time.Time         `json:"created_at"`
	LastSeenAt        time.Time         `json:"last_seen_at"`
	IdleExpiresAt     time.Time         `json:"idle_expires_at"`
	AbsoluteExpiresAt time.Time         `json:"absolute_expires_at"`
	Embed             *sessionEmbedView `json:"embed,omitempty"`
}

type sessionEmbedView struct {
	TenantID     string   `json:"tenantId"`
	WorkbenchKey string   `json:"workbenchKey"`
	WorkspaceID  string   `json:"workspaceId"`
	Capabilities []string `json:"capabilities"`
}

type sessionResponse struct {
	Session   sessionView   `json:"session"`
	Principal identity.User `json:"principal"`
	CSRFToken string        `json:"csrf_token"`
}

func (s *Server) clockNow() time.Time {
	if s.clock != nil {
		return s.clock().UTC()
	}
	return time.Now().UTC()
}

func (s *Server) requireSessions(w http.ResponseWriter, r *http.Request) bool {
	if s.sessions != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Session store is not available.")
	return false
}

func sessionCookieValue(r *http.Request) string {
	c, err := r.Cookie(session.CookieName)
	if err != nil || c == nil {
		return ""
	}
	return strings.TrimSpace(c.Value)
}

func unsafeMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func (s *Server) validCSRF(r *http.Request, rec session.Record) bool {
	header := strings.TrimSpace(r.Header.Get(session.CSRFHeader))
	c, err := r.Cookie(session.CSRFCookieName)
	if err != nil || c == nil {
		return false
	}
	if !session.SecretsEqual(header, strings.TrimSpace(c.Value)) {
		return false
	}
	return session.CSRFMatches(rec, header)
}

func headerIdentityConflict(r *http.Request, user identity.User) bool {
	issuer := strings.TrimSpace(r.Header.Get(headerIssuer))
	subject := strings.TrimSpace(r.Header.Get(headerSubject))
	if issuer == "" && subject == "" {
		return false
	}
	if issuer != "" && issuer != user.Issuer {
		return true
	}
	if subject != "" && subject != user.ExternalSubject {
		return true
	}
	return false
}

func attachPrincipal(r *http.Request, user identity.User, rec *session.Record, token string) {
	pc := &principalContext{user: user, session: rec, token: token}
	*r = *r.WithContext(context.WithValue(r.Context(), principalKey, pc))
}

func principalFromRequest(r *http.Request) *principalContext {
	pc, _ := r.Context().Value(principalKey).(*principalContext)
	return pc
}

func (s *Server) requireHeaderPrincipal(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	if !s.sec.TrustIdentityHeaders {
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	issuer := strings.TrimSpace(r.Header.Get(headerIssuer))
	subject := strings.TrimSpace(r.Header.Get(headerSubject))
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	display := strings.TrimSpace(r.Header.Get(headerDisplayName))
	user, err := s.store.UpsertUser(r.Context(), issuer, subject, display)
	if err != nil {
		writeIdentityError(w, r, err)
		return identity.User{}, false
	}
	if user.Status != "active" {
		WriteForbidden(w, r)
		return identity.User{}, false
	}
	attachPrincipal(r, user, nil, "")
	return user, true
}

func (s *Server) requireSessionPrincipal(w http.ResponseWriter, r *http.Request, token string) (identity.User, bool) {
	if !s.requireSessions(w, r) {
		return identity.User{}, false
	}
	rec, err := s.sessions.Lookup(r.Context(), token, s.clockNow())
	if err != nil {
		event := session.EventAuthRejected
		reason := "unknown session"
		switch {
		case errors.Is(err, session.ErrExpired):
			event = session.EventExpired
			reason = "expired"
		case errors.Is(err, session.ErrRevoked):
			reason = "revoked"
		}
		s.auditSession(r, rec, event, session.OutcomeDenied, reason)
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	if unsafeMethod(r.Method) && !s.validCSRF(r, rec) {
		s.auditSession(r, rec, session.EventCSRFRejected, session.OutcomeDenied, "csrf mismatch")
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "CSRF validation failed.")
		return identity.User{}, false
	}
	user, err := s.store.GetUser(r.Context(), rec.UserID)
	if err != nil {
		s.auditSession(r, rec, session.EventAuthRejected, session.OutcomeDenied, "missing user")
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	if user.Status != "active" {
		s.auditSession(r, rec, session.EventPrivilegeDenied, session.OutcomeDenied, "disabled user")
		WriteForbidden(w, r)
		return identity.User{}, false
	}
	if headerIdentityConflict(r, user) {
		s.auditSession(r, rec, session.EventPrivilegeDenied, session.OutcomeDenied, "identity header conflict")
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Session identity does not match the supplied identity headers.")
		return identity.User{}, false
	}
	attachPrincipal(r, user, &rec, token)
	return user, true
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) || !s.requireSessions(w, r) {
		return
	}
	issuer, subject, display, ok := s.sessionCreateIdentity(w, r)
	if !ok {
		return
	}
	user, err := s.store.UpsertUser(r.Context(), issuer, subject, display)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if user.Status != "active" {
		WriteForbidden(w, r)
		return
	}
	policy := s.sec.sessionPolicy()
	issued, err := s.sessions.Create(r.Context(), user.ID, s.clockNow(), policy.IdleTimeout, policy.AbsoluteTimeout)
	if err != nil {
		writeSessionError(w, r, err)
		return
	}
	s.issueSessionCookies(w, r, issued)
	s.auditSession(r, issued.Record, session.EventCreated, session.OutcomeAllowed, "issued")
	writeJSON(w, http.StatusCreated, sessionResponse{
		Session:   viewSession(issued.Record),
		Principal: user,
		CSRFToken: issued.CSRF,
	})
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	if sessionCookieValue(r) == "" {
		WriteUnauthenticated(w, r)
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
	csrf := ""
	if c, err := r.Cookie(session.CSRFCookieName); err == nil && c != nil {
		csrf = c.Value
	}
	writeJSON(w, http.StatusOK, sessionResponse{
		Session:   viewSession(*pc.session),
		Principal: user,
		CSRFToken: csrf,
	})
}

func (s *Server) refreshSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	pc := principalFromRequest(r)
	if pc == nil || pc.session == nil || pc.token == "" {
		WriteUnauthenticated(w, r)
		return
	}
	if !s.requireSessions(w, r) {
		return
	}
	policy := s.sec.sessionPolicy()
	presentedCSRF := strings.TrimSpace(r.Header.Get(session.CSRFHeader))
	issued, err := s.sessions.Refresh(r.Context(), pc.token, presentedCSRF, s.clockNow(), policy.IdleTimeout)
	if err != nil {
		if errors.Is(err, session.ErrExpired) || errors.Is(err, session.ErrRevoked) {
			s.auditSession(r, issued.Record, session.EventExpired, session.OutcomeDenied, err.Error())
			WriteUnauthenticated(w, r)
			return
		}
		if errors.Is(err, session.ErrConflict) {
			s.auditSession(r, issued.Record, session.EventCSRFRejected, session.OutcomeDenied, "csrf rotation conflict")
		}
		writeSessionError(w, r, err)
		return
	}
	s.issueSessionCookies(w, r, issued)
	s.auditSession(r, issued.Record, session.EventRefreshed, session.OutcomeAllowed, "refreshed")
	writeJSON(w, http.StatusOK, sessionResponse{
		Session:   viewSession(issued.Record),
		Principal: user,
		CSRFToken: issued.CSRF,
	})
}

func (s *Server) logoutSession(w http.ResponseWriter, r *http.Request) {
	if !s.requireSessions(w, r) {
		return
	}
	token := sessionCookieValue(r)
	if token == "" {
		s.clearSessionCookies(w, r)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	rec, err := s.sessions.Lookup(r.Context(), token, s.clockNow())
	if err != nil && !errors.Is(err, session.ErrExpired) && !errors.Is(err, session.ErrRevoked) {
		s.clearSessionCookies(w, r)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if rec.ID != "" && !s.validCSRF(r, rec) {
		s.auditSession(r, rec, session.EventCSRFRejected, session.OutcomeDenied, "csrf mismatch")
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "CSRF validation failed.")
		return
	}
	if rec.ID != "" {
		revoked, revokeErr := s.sessions.Revoke(r.Context(), token, s.clockNow())
		if revokeErr != nil && !errors.Is(revokeErr, session.ErrNotFound) {
			writeSessionError(w, r, revokeErr)
			return
		}
		s.auditSession(r, revoked, session.EventRevoked, session.OutcomeAllowed, "revoked")
	}
	s.clearSessionCookies(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSessionAudit(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireSessions(w, r) {
		return
	}
	items, err := s.sessions.ListAudit(r.Context(), user.ID, 100)
	if err != nil {
		writeSessionError(w, r, err)
		return
	}
	if items == nil {
		items = []session.AuditEvent{}
	}
	writeJSON(w, http.StatusOK, listResponse[session.AuditEvent]{Items: items})
}

func viewSession(rec session.Record) sessionView {
	view := sessionView{
		ID:                rec.ID,
		CreatedAt:         rec.CreatedAt,
		LastSeenAt:        rec.LastSeenAt,
		IdleExpiresAt:     rec.IdleExpiresAt,
		AbsoluteExpiresAt: rec.AbsoluteExpiresAt,
	}
	if rec.Binding.Bound() {
		view.Embed = &sessionEmbedView{
			TenantID:     rec.Binding.TenantID,
			WorkbenchKey: rec.Binding.WorkbenchKey,
			WorkspaceID:  rec.Binding.WorkspaceID,
			Capabilities: append([]string(nil), rec.Binding.Capabilities...),
		}
	}
	return view
}

func (s *Server) issueSessionCookies(w http.ResponseWriter, r *http.Request, issued session.Issued) {
	https := s.sec.requestIsHTTPS(r)
	maxAge := int(issued.Record.IdleExpiresAt.Sub(s.clockNow()).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name:     session.CookieName,
		Value:    issued.Token,
		Path:     session.CookiePath,
		HttpOnly: true,
		Secure:   https,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     session.CSRFCookieName,
		Value:    issued.CSRF,
		Path:     session.CookiePath,
		HttpOnly: false,
		Secure:   https,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   maxAge,
	})
}

func (s *Server) clearSessionCookies(w http.ResponseWriter, r *http.Request) {
	https := s.sec.requestIsHTTPS(r)
	http.SetCookie(w, &http.Cookie{
		Name:     session.CookieName,
		Value:    "",
		Path:     session.CookiePath,
		HttpOnly: true,
		Secure:   https,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     session.CSRFCookieName,
		Value:    "",
		Path:     session.CookiePath,
		HttpOnly: false,
		Secure:   https,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

func (s *Server) auditSession(r *http.Request, rec session.Record, eventType, outcome, reason string) {
	if s.sessions == nil {
		return
	}
	pc := principalFromRequest(r)
	userID := rec.UserID
	sessionID := rec.ID
	if userID == "" && pc != nil {
		userID = pc.user.ID
		if sessionID == "" && pc.session != nil {
			sessionID = pc.session.ID
		}
	}
	event := session.AuditEvent{
		UserID:    userID,
		SessionID: sessionID,
		EventType: eventType,
		Outcome:   outcome,
		Reason:    reason,
		RequestID: RequestIDFromContext(r.Context()),
		CreatedAt: s.clockNow(),
	}
	if err := s.sessions.Audit(r.Context(), event); err != nil && s.log != nil {
		s.log.Error("session_audit_persist",
			"request_id", event.RequestID,
			"error", err.Error(),
		)
	}
	if s.log != nil {
		s.log.Info("session_audit",
			"request_id", event.RequestID,
			"event_type", eventType,
			"outcome", outcome,
			"reason", reason,
			"user_id", userID,
			"session_id", sessionID,
		)
	}
}

func (s *Server) sessionCreateIdentity(w http.ResponseWriter, r *http.Request) (issuer, subject, display string, ok bool) {
	if !s.sec.TrustIdentityHeaders {
		WriteUnauthenticated(w, r)
		return "", "", "", false
	}
	headerIssuer := strings.TrimSpace(r.Header.Get(headerIssuer))
	headerSubject := strings.TrimSpace(r.Header.Get(headerSubject))
	display = strings.TrimSpace(r.Header.Get(headerDisplayName))
	var body createSessionRequest
	if r.Header.Get("Content-Type") != "" {
		if !DecodeJSON(w, r, &body) {
			return "", "", "", false
		}
		body.Issuer = strings.TrimSpace(body.Issuer)
		body.ExternalSubject = strings.TrimSpace(body.ExternalSubject)
		body.DisplayName = strings.TrimSpace(body.DisplayName)
	}
	hasHeader := headerIssuer != "" || headerSubject != ""
	if hasHeader {
		if body.Issuer != "" && body.Issuer != headerIssuer {
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Request body identity does not match authenticated identity headers.")
			return "", "", "", false
		}
		if body.ExternalSubject != "" && body.ExternalSubject != headerSubject {
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Request body identity does not match authenticated identity headers.")
			return "", "", "", false
		}
		issuer, subject = headerIssuer, headerSubject
		if display == "" {
			display = body.DisplayName
		}
	} else {
		issuer, subject = body.Issuer, body.ExternalSubject
		if display == "" {
			display = body.DisplayName
		}
	}
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		WriteUnauthenticated(w, r)
		return "", "", "", false
	}
	return issuer, subject, display, true
}

func writeSessionError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, session.ErrNotFound), errors.Is(err, session.ErrExpired), errors.Is(err, session.ErrRevoked):
		WriteUnauthenticated(w, r)
	case errors.Is(err, session.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "The session was refreshed elsewhere. Retry with the current CSRF token.")
	case errors.Is(err, session.ErrInvalid):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The session request is not valid.")
	case errors.Is(err, session.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Session store is not available.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
