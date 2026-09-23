package core

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

type principalContext struct {
	User    identity.User
	Session *session.Record
	Token   string
}

type createSessionRequest struct {
	Issuer          string `json:"issuer"`
	ExternalSubject string `json:"external_subject"`
	DisplayName     string `json:"display_name"`
}

type sessionView struct {
	ID                 string            `json:"id"`
	CreatedAt          time.Time         `json:"created_at"`
	LastSeenAt         time.Time         `json:"last_seen_at"`
	IdleExpiresAt      time.Time         `json:"idle_expires_at"`
	AbsoluteExpiresAt  time.Time         `json:"absolute_expires_at"`
	MustChangePassword bool              `json:"must_change_password,omitempty"`
	Embed              *sessionEmbedView `json:"embed,omitempty"`
}

// sessionEmbedView is the authoritative embed-chrome payload on a bound
// session. Present only after POST /embed/exchange. No secrets, no
// compact JWS, no assertion leftovers. Standalone sessions omit this
// object entirely (ADV-021).
type sessionEmbedView struct {
	Mode          string   `json:"mode"`
	SDK           string   `json:"sdk"`
	TenantID      string   `json:"tenantId"`
	TenantSlug    string   `json:"tenantSlug,omitempty"`
	TenantName    string   `json:"tenantName,omitempty"`
	WorkbenchKey  string   `json:"workbenchKey"`
	WorkspaceID   string   `json:"workspaceId"`
	WorkspaceName string   `json:"workspaceName,omitempty"`
	Capabilities  []string `json:"capabilities"`
}

type SessionResponse struct {
	Session   sessionView   `json:"session"`
	Principal identity.User `json:"principal"`
	CSRFToken string        `json:"csrf_token"`
}

func (s *Server) ClockNow() time.Time {
	if s.Clock != nil {
		return s.Clock().UTC()
	}
	return time.Now().UTC()
}

func (s *Server) RequireSessions(w http.ResponseWriter, r *http.Request) bool {
	if s.Sessions != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Session store is not available.")
	return false
}

func SessionCookieValue(r *http.Request) string {
	c, err := r.Cookie(session.CookieName)
	if err != nil || c == nil {
		return ""
	}
	return strings.TrimSpace(c.Value)
}

// peekCatalogView reads an optional ff_session for catalog disclosure.
// It never writes a response: missing/invalid cookies stay unauthenticated
// so GET /embed/catalog remains 200 (ADV-011 frameAncestors).
func (s *Server) PeekCatalogView(r *http.Request) embed.CatalogView {
	token := SessionCookieValue(r)
	if token == "" || s.Sessions == nil {
		return embed.CatalogView{}
	}
	rec, err := s.Sessions.Lookup(r.Context(), token, s.ClockNow())
	if err != nil {
		return embed.CatalogView{}
	}
	view := embed.CatalogView{Authenticated: true, EmbedBound: rec.Binding.Bound()}
	if rec.Binding.Bound() {
		view.Capabilities = append([]string(nil), rec.Binding.Capabilities...)
		return view
	}
	if s.Store == nil {
		return view
	}
	user, err := s.Store.GetUser(r.Context(), rec.UserID)
	if err != nil || user.Status != "active" {
		return embed.CatalogView{}
	}
	if authz.IsPlatformAdmin(user.Issuer, user.ExternalSubject, s.PlatformAdmins) {
		view.Capabilities = []string{authz.PermPlatformAdminister}
		return view
	}
	items, err := s.Store.ListWorkspacesForUser(r.Context(), user.ID)
	if err != nil {
		return view
	}
	for _, item := range items {
		if embed.GrantsMembershipIsolation(item.Permissions) {
			view.Capabilities = []string{authz.PermWorkspaceAdminister}
			return view
		}
	}
	return view
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
	issuer := strings.TrimSpace(r.Header.Get(HeaderIssuer))
	subject := strings.TrimSpace(r.Header.Get(HeaderSubject))
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
	pc := &principalContext{User: user, Session: rec, Token: token}
	*r = *r.WithContext(context.WithValue(r.Context(), principalKey, pc))
}

func PrincipalFromRequest(r *http.Request) *principalContext {
	pc, _ := r.Context().Value(principalKey).(*principalContext)
	return pc
}

func (s *Server) requireHeaderPrincipal(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	if !s.Sec.TrustIdentityHeaders {
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	issuer := strings.TrimSpace(r.Header.Get(HeaderIssuer))
	subject := strings.TrimSpace(r.Header.Get(HeaderSubject))
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	display := strings.TrimSpace(r.Header.Get(HeaderDisplayName))
	user, err := s.Store.UpsertUser(r.Context(), issuer, subject, display)
	if err != nil {
		WriteIdentityError(w, r, err)
		return identity.User{}, false
	}
	if user.Status != "active" {
		WriteForbidden(w, r)
		return identity.User{}, false
	}
	attachPrincipal(r, user, nil, "")
	return user, true
}

func (s *Server) RequireSessionPrincipal(w http.ResponseWriter, r *http.Request, token string) (identity.User, bool) {
	if !s.RequireSessions(w, r) {
		return identity.User{}, false
	}
	rec, err := s.Sessions.Lookup(r.Context(), token, s.ClockNow())
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
		s.AuditSession(r, rec, event, session.OutcomeDenied, reason)
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	if unsafeMethod(r.Method) && !s.validCSRF(r, rec) {
		s.AuditSession(r, rec, session.EventCSRFRejected, session.OutcomeDenied, "csrf mismatch")
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "CSRF validation failed.")
		return identity.User{}, false
	}
	user, err := s.Store.GetUser(r.Context(), rec.UserID)
	if err != nil {
		s.AuditSession(r, rec, session.EventAuthRejected, session.OutcomeDenied, "missing user")
		WriteUnauthenticated(w, r)
		return identity.User{}, false
	}
	if user.Status != "active" {
		s.AuditSession(r, rec, session.EventPrivilegeDenied, session.OutcomeDenied, "disabled user")
		WriteForbidden(w, r)
		return identity.User{}, false
	}
	if headerIdentityConflict(r, user) {
		s.AuditSession(r, rec, session.EventPrivilegeDenied, session.OutcomeDenied, "identity header conflict")
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Session identity does not match the supplied identity headers.")
		return identity.User{}, false
	}
	attachPrincipal(r, user, &rec, token)
	return user, true
}

func (s *Server) CreateSession(w http.ResponseWriter, r *http.Request) {
	if !s.RequireStore(w, r) || !s.RequireSessions(w, r) {
		return
	}
	issuer, subject, display, ok := s.sessionCreateIdentity(w, r)
	if !ok {
		return
	}
	user, err := s.Store.UpsertUser(r.Context(), issuer, subject, display)
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	if user.Status != "active" {
		WriteForbidden(w, r)
		return
	}
	s.MintStandaloneSession(w, r, user, "issued")
}

// mintStandaloneSession issues the existing ff_session / ff_csrf pair
// (standalone Lax / Strict). Used by trusted-dev POST /session.
// Never binds session.embed. Trusted-dev is not the local one-time
// credential — must_change_password stays false here.
func (s *Server) MintStandaloneSession(w http.ResponseWriter, r *http.Request, user identity.User, reason string) {
	s.mintStandaloneSessionWithClaim(w, r, user, reason, false)
}

// mintStandaloneSessionWithClaim is POST /login: same cookies, plus the
// session claim Chloe uses to gate product chrome until change-password.
func (s *Server) mintStandaloneSessionWithClaim(w http.ResponseWriter, r *http.Request, user identity.User, reason string, mustChange bool) {
	if !s.RequireSessions(w, r) {
		return
	}
	policy := s.Sec.sessionPolicy()
	issued, err := s.Sessions.Create(r.Context(), user.ID, s.ClockNow(), policy.IdleTimeout, policy.AbsoluteTimeout, session.CreateOpts{
		AuthMethod: session.AuthMethodForReason(reason),
	})
	if err != nil {
		writeSessionError(w, r, err)
		return
	}
	s.issueSessionCookies(w, r, issued)
	s.AuditSession(r, issued.Record, session.EventCreated, session.OutcomeAllowed, reason)
	view := s.viewSession(r.Context(), issued.Record)
	view.MustChangePassword = mustChange
	WriteJSON(w, http.StatusCreated, SessionResponse{
		Session:   view,
		Principal: user,
		CSRFToken: issued.CSRF,
	})
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	if SessionCookieValue(r) == "" {
		WriteUnauthenticated(w, r)
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

func (s *Server) refreshSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	pc := PrincipalFromRequest(r)
	if pc == nil || pc.Session == nil || pc.Token == "" {
		WriteUnauthenticated(w, r)
		return
	}
	if !s.RequireSessions(w, r) {
		return
	}
	policy := s.Sec.sessionPolicy()
	presentedCSRF := strings.TrimSpace(r.Header.Get(session.CSRFHeader))
	issued, err := s.Sessions.Refresh(r.Context(), pc.Token, presentedCSRF, s.ClockNow(), policy.IdleTimeout)
	if err != nil {
		if errors.Is(err, session.ErrExpired) || errors.Is(err, session.ErrRevoked) {
			s.AuditSession(r, issued.Record, session.EventExpired, session.OutcomeDenied, err.Error())
			WriteUnauthenticated(w, r)
			return
		}
		if errors.Is(err, session.ErrConflict) {
			s.AuditSession(r, issued.Record, session.EventCSRFRejected, session.OutcomeDenied, "csrf rotation conflict")
		}
		writeSessionError(w, r, err)
		return
	}
	s.issueSessionCookies(w, r, issued)
	s.AuditSession(r, issued.Record, session.EventRefreshed, session.OutcomeAllowed, "refreshed")
	WriteJSON(w, http.StatusOK, SessionResponse{
		Session:   s.viewSessionForUser(r.Context(), issued.Record, user.ID),
		Principal: user,
		CSRFToken: issued.CSRF,
	})
}

func (s *Server) logoutSession(w http.ResponseWriter, r *http.Request) {
	if !s.RequireSessions(w, r) {
		return
	}
	token := SessionCookieValue(r)
	if token == "" {
		s.clearSessionCookies(w, r)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	rec, err := s.Sessions.Lookup(r.Context(), token, s.ClockNow())
	if err != nil && !errors.Is(err, session.ErrExpired) && !errors.Is(err, session.ErrRevoked) {
		s.clearSessionCookies(w, r)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if rec.ID != "" && !s.validCSRF(r, rec) {
		s.AuditSession(r, rec, session.EventCSRFRejected, session.OutcomeDenied, "csrf mismatch")
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "CSRF validation failed.")
		return
	}
	if rec.ID != "" {
		revoked, revokeErr := s.Sessions.Revoke(r.Context(), token, s.ClockNow())
		if revokeErr != nil && !errors.Is(revokeErr, session.ErrNotFound) {
			writeSessionError(w, r, revokeErr)
			return
		}
		s.AuditSession(r, revoked, session.EventRevoked, session.OutcomeAllowed, "revoked")
	}
	s.clearSessionCookies(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSessionAudit(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.RequireSessions(w, r) {
		return
	}
	items, err := s.Sessions.ListAudit(r.Context(), user.ID, 100)
	if err != nil {
		writeSessionError(w, r, err)
		return
	}
	if items == nil {
		items = []session.AuditEvent{}
	}
	WriteJSON(w, http.StatusOK, ListResponse[session.AuditEvent]{Items: items})
}

func (s *Server) viewSession(ctx context.Context, rec session.Record) sessionView {
	return s.viewSessionForUser(ctx, rec, rec.UserID)
}

func (s *Server) viewSessionForUser(ctx context.Context, rec session.Record, userID string) sessionView {
	view := viewSession(rec)
	s.attachEmbedChrome(ctx, view.Embed)
	if userID != "" {
		view.MustChangePassword = s.localLoginMustChange(ctx, userID)
	}
	return view
}

func (s *Server) localLoginMustChange(ctx context.Context, userID string) bool {
	if s.Store == nil || strings.TrimSpace(userID) == "" {
		return false
	}
	cred, err := s.Store.LookupLocalLoginByUser(ctx, userID)
	if err != nil {
		return false
	}
	return cred.MustChangePassword
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
		caps := append([]string{}, rec.Binding.Capabilities...)
		view.Embed = &sessionEmbedView{
			Mode:         "embed",
			SDK:          embed.SDKVersion,
			TenantID:     rec.Binding.TenantID,
			WorkbenchKey: rec.Binding.WorkbenchKey,
			WorkspaceID:  rec.Binding.WorkspaceID,
			Capabilities: caps,
		}
	}
	return view
}

// attachEmbedChrome fills chrome-safe tenant/workspace display from the
// identity store. Lookup failure leaves IDs in place and does not fail
// GET /session. Never copies assertion leftovers or secrets.
func (s *Server) attachEmbedChrome(ctx context.Context, chrome *sessionEmbedView) {
	if chrome == nil || s.Store == nil {
		return
	}
	if chrome.WorkspaceID != "" {
		if ws, err := s.Store.GetWorkspace(ctx, chrome.WorkspaceID); err == nil {
			chrome.WorkspaceName = strings.TrimSpace(ws.Name)
			if chrome.TenantID == "" {
				chrome.TenantID = ws.TenantID
			}
		}
	}
	if chrome.TenantID != "" {
		if tenant, err := s.Store.GetTenant(ctx, chrome.TenantID); err == nil {
			chrome.TenantSlug = strings.TrimSpace(tenant.Slug)
			chrome.TenantName = strings.TrimSpace(tenant.Name)
		}
	}
}

func attachEmbedChromeKnown(chrome *sessionEmbedView, tenant identity.Tenant, ws identity.Workspace) {
	if chrome == nil {
		return
	}
	chrome.TenantSlug = strings.TrimSpace(tenant.Slug)
	chrome.TenantName = strings.TrimSpace(tenant.Name)
	if name := strings.TrimSpace(ws.Name); name != "" {
		chrome.WorkspaceName = name
	}
	if chrome.WorkspaceID == "" {
		chrome.WorkspaceID = ws.ID
	}
}

func (s *Server) issueSessionCookies(w http.ResponseWriter, r *http.Request, issued session.Issued) {
	https := s.Sec.RequestIsHTTPS(r)
	maxAge := int(issued.Record.IdleExpiresAt.Sub(s.ClockNow()).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	writeSessionCookiePair(w, issued.Token, issued.CSRF, maxAge, https, issued.Record.Binding.Bound())
}

func (s *Server) clearSessionCookies(w http.ResponseWriter, r *http.Request) {
	https := s.Sec.RequestIsHTTPS(r)
	// Expire both first-party and CHIPS pairs. Partitioned cookies live
	// in a different jar; clearing only Lax/Strict would leave the
	// embed session cookie in a cross-site iframe.
	writeSessionCookiePair(w, "", "", -1, https, false)
	writeSessionCookiePair(w, "", "", -1, true, true)
}

func (s *Server) AuditSession(r *http.Request, rec session.Record, eventType, outcome, reason string) {
	if s.Sessions == nil {
		return
	}
	pc := PrincipalFromRequest(r)
	userID := rec.UserID
	sessionID := rec.ID
	if userID == "" && pc != nil {
		userID = pc.User.ID
		if sessionID == "" && pc.Session != nil {
			sessionID = pc.Session.ID
		}
	}
	event := session.AuditEvent{
		UserID:    userID,
		SessionID: sessionID,
		EventType: eventType,
		Outcome:   outcome,
		Reason:    reason,
		RequestID: RequestIDFromContext(r.Context()),
		CreatedAt: s.ClockNow(),
	}
	if err := s.Sessions.Audit(r.Context(), event); err != nil && s.Log != nil {
		s.Log.Error("session_audit_persist",
			"request_id", event.RequestID,
			"error", err.Error(),
		)
	}
	if s.Log != nil {
		s.Log.Info("session_audit",
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
	if !s.Sec.TrustIdentityHeaders {
		WriteUnauthenticated(w, r)
		return "", "", "", false
	}
	HeaderIssuer := strings.TrimSpace(r.Header.Get(HeaderIssuer))
	HeaderSubject := strings.TrimSpace(r.Header.Get(HeaderSubject))
	display = strings.TrimSpace(r.Header.Get(HeaderDisplayName))
	var body createSessionRequest
	if r.Header.Get("Content-Type") != "" {
		if !DecodeJSON(w, r, &body) {
			return "", "", "", false
		}
		body.Issuer = strings.TrimSpace(body.Issuer)
		body.ExternalSubject = strings.TrimSpace(body.ExternalSubject)
		body.DisplayName = strings.TrimSpace(body.DisplayName)
	}
	hasHeader := HeaderIssuer != "" || HeaderSubject != ""
	if hasHeader {
		if body.Issuer != "" && body.Issuer != HeaderIssuer {
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Request body identity does not match authenticated identity headers.")
			return "", "", "", false
		}
		if body.ExternalSubject != "" && body.ExternalSubject != HeaderSubject {
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Request body identity does not match authenticated identity headers.")
			return "", "", "", false
		}
		issuer, subject = HeaderIssuer, HeaderSubject
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
