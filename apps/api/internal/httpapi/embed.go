package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

type mintAssertionRequest struct {
	ID              string   `json:"id"`
	WorkspaceIDHost string   `json:"workspace_id"`
	Subject         string   `json:"subject"`
	DisplayName     string   `json:"displayName"`
	Issuer          string   `json:"issuer"`
	TenantID        string   `json:"tenantId"`
	WorkbenchKey    string   `json:"workbenchKey"`
	WorkspaceID     string   `json:"workspaceId"`
	Capabilities    []string `json:"capabilities"`
	TTLSeconds      int      `json:"ttlSeconds"`
}

type exchangeAssertionRequest struct {
	Assertion   string `json:"assertion"`
	SDK         string `json:"sdk"`
	HostIssuer  string `json:"hostIssuer"`
	HostContext string `json:"hostContext"`
}

type embedExchangeResponse struct {
	Session      sessionView        `json:"session"`
	Principal    identity.User      `json:"principal"`
	CSRFToken    string             `json:"csrf_token"`
	Assertion    embed.PublicView   `json:"assertion"`
	Workspace    identity.Workspace `json:"workspace"`
	Tenant       identity.Tenant    `json:"tenant"`
	Capabilities []string           `json:"capabilities"`
}

func (s *Server) requireEmbedKeys(w http.ResponseWriter, r *http.Request) bool {
	if s.embedMaterial().Ready() {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Embed signing key is not available.")
	return false
}

func (s *Server) getEmbedCatalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, embed.NewCatalogFor(s.portalFrames, s.embedMintIssuers, s.peekCatalogView(r)))
}

func (s *Server) getEmbedJWKS(w http.ResponseWriter, r *http.Request) {
	if s.embedRing != nil {
		if err := s.embedRing.Refresh(r.Context(), s.clockNow()); err != nil {
			writeEmbedError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, s.embedMaterial().PublicJWKS())
}

type rotateEmbedKeyRequest struct {
	Action       string          `json:"action"`
	Kid          string          `json:"kid"`
	PublicJWK    embed.PublicJWK `json:"publicJwk"`
	OverlapUntil string          `json:"overlapUntil"`
}

func (s *Server) rotateEmbedKeys(w http.ResponseWriter, r *http.Request) {
	if !s.requireEmbedKeys(w, r) {
		return
	}
	if s.embedRing == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Embed signing is not available.")
		return
	}
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !authz.IsPlatformAdmin(user.Issuer, user.ExternalSubject, s.platformAdmins) {
		s.auditEmbed(r, embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonPrivilege, "", "", user.Issuer, user.ExternalSubject)
		if !s.requirePlatformAdmin(w, r, user) {
			return
		}
	}
	var req rotateEmbedKeyRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	action := strings.TrimSpace(req.Action)
	if action == "" {
		action = "register-overlap"
	}
	switch action {
	case "register-overlap":
		rawUntil := strings.TrimSpace(req.OverlapUntil)
		if rawUntil == "" {
			s.auditEmbed(r, embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonOverlap, "", req.PublicJWK.Kid, user.Issuer, user.ExternalSubject)
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "overlapUntil is required and must be a short RFC3339 expiry (max 4h).")
			return
		}
		parsed, err := time.Parse(time.RFC3339, rawUntil)
		if err != nil {
			s.auditEmbed(r, embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonOverlap, "", req.PublicJWK.Kid, user.Issuer, user.ExternalSubject)
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "overlapUntil must be RFC3339.")
			return
		}
		until := parsed.UTC()
		if err := embed.ValidateOverlapUntil(until, s.clockNow()); err != nil {
			s.auditEmbed(r, embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonOverlap, "", req.PublicJWK.Kid, user.Issuer, user.ExternalSubject)
			writeEmbedError(w, r, err)
			return
		}
		if err := s.embedRing.AddOverlap(r.Context(), req.PublicJWK, until, s.clockNow()); err != nil {
			s.auditEmbed(r, embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonOverlap, "", req.PublicJWK.Kid, user.Issuer, user.ExternalSubject)
			writeEmbedError(w, r, err)
			return
		}
		s.auditEmbed(r, embed.EventOverlapRegister, session.OutcomeAllowed, embed.ReasonOverlapReg, "", req.PublicJWK.Kid, user.Issuer, user.ExternalSubject)
	case "retire":
		kid := strings.TrimSpace(req.Kid)
		if kid == "" {
			kid = strings.TrimSpace(req.PublicJWK.Kid)
		}
		if err := s.embedRing.RetireOverlap(r.Context(), kid); err != nil {
			s.auditEmbed(r, embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonOverlap, "", kid, user.Issuer, user.ExternalSubject)
			writeEmbedError(w, r, err)
			return
		}
		s.auditEmbed(r, embed.EventOverlapRetire, session.OutcomeAllowed, embed.ReasonRetire, "", kid, user.Issuer, user.ExternalSubject)
	default:
		s.auditEmbed(r, embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonRejected, "", "", user.Issuer, user.ExternalSubject)
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "action must be register-overlap or retire.")
		return
	}
	writeJSON(w, http.StatusOK, s.embedMaterial().PublicJWKS())
}

func (s *Server) mintEmbedAssertion(w http.ResponseWriter, r *http.Request) {
	if !s.requireEmbedKeys(w, r) {
		return
	}
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.allowEmbedMint(r, user.Issuer, user.ExternalSubject) {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonRateLimited, "", s.embedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		s.writeEmbedRateLimited(w, r, "Embed mint rate limit exceeded. Retry after the configured window.")
		return
	}
	ws, tenant, _, perms, ok := s.requireAccess(w, r, user, "")
	if !ok {
		return
	}
	var req mintAssertionRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) != "" || strings.TrimSpace(req.WorkspaceIDHost) != "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if err := confirmMintBinding(req, tenant, ws); err != nil {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonTenancy, "", s.embedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		writeIdentityError(w, r, err)
		return
	}
	caps := req.Capabilities
	if len(caps) == 0 {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonCapability, "", s.embedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "capabilities are required and must be a subset of the caller.")
		return
	}
	for _, c := range caps {
		if !authz.Known(c) {
			s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonCapability, "", s.embedMaterial().KeyID, user.Issuer, user.ExternalSubject)
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "capabilities are required and must be a subset of the caller.")
			return
		}
		if !authz.Allows(perms, c) {
			s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonCapability, "", s.embedMaterial().KeyID, user.Issuer, user.ExternalSubject)
			WriteForbidden(w, r)
			return
		}
	}
	issuer, subject, impersonating, err := authz.BindMintIdentity(
		user.Issuer, user.ExternalSubject, req.Issuer, req.Subject,
		authz.CanEmbedImpersonate(user.Issuer, user.ExternalSubject, s.platformAdmins),
	)
	if err != nil {
		reason := embed.ReasonImpersonation
		if errors.Is(err, authz.ErrMintIssuerSpoof) {
			reason = embed.ReasonIssuer
		}
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, reason, "", s.embedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		if pc := principalFromRequest(r); pc != nil && pc.session != nil {
			s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "missing embed.impersonate")
		}
		WriteForbidden(w, r)
		return
	}
	if !embed.IssuerAllowed(issuer, s.embedMintIssuers) {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonIssuer, "", s.embedMaterial().KeyID, issuer, subject)
		writeEmbedError(w, r, embed.ErrIssuerNotAllowed)
		return
	}
	display := strings.TrimSpace(req.DisplayName)
	if display == "" && subject == user.ExternalSubject {
		display = user.DisplayName
	}
	ttl := time.Duration(req.TTLSeconds) * time.Second
	minted, _, err := embed.Mint(s.embedMaterial(), embed.MintInput{
		Issuer:       issuer,
		Subject:      subject,
		DisplayName:  display,
		Host:         user.Issuer,
		Context:      embed.HostContextEmbed,
		TenantID:     tenant.ID,
		WorkbenchKey: ws.WorkbenchKey,
		WorkspaceID:  ws.ID,
		Capabilities: caps,
		TTL:          ttl,
		Audience:     embed.DefaultAudience,
		Now:          s.clockNow(),
	})
	if err != nil {
		writeEmbedError(w, r, err)
		return
	}
	reason := embed.ReasonIssued
	if impersonating {
		reason = embed.ReasonImpersonated
	}
	s.auditEmbed(r, embed.EventMinted, session.OutcomeAllowed, reason, minted.TokenID, minted.KeyID, issuer, subject)
	writeJSON(w, http.StatusCreated, minted)
}

func (s *Server) exchangeEmbedAssertion(w http.ResponseWriter, r *http.Request) {
	if !s.requireStore(w, r) || !s.requireSessions(w, r) || !s.requireEmbedKeys(w, r) {
		return
	}
	var req exchangeAssertionRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.SDK) != "" && req.SDK != embed.SDKVersion {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Unsupported embed SDK version.")
		return
	}
	if strings.TrimSpace(req.Assertion) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "assertion is required.")
		return
	}
	peek, _ := peekEmbedClaims(req.Assertion)
	if !s.allowEmbedExchange(r, peek.Issuer, peek.Subject) {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonRateLimited, peek.TokenID, s.embedMaterial().KeyID, peek.Issuer, peek.Subject)
		s.writeEmbedRateLimited(w, r, "Embed exchange rate limit exceeded. Retry after the configured window.")
		return
	}
	// ADV-008: verify signature, audience, issuer allowlist, nbf/exp,
	// claims, and consume jti before any tenant/workbench lookup so a
	// forged assertion cannot probe workspace existence.
	// ADV-023: bind iss to the minting host issuer context (Portal vs
	// standalone embed) before that lookup as well.
	verified, err := s.verifyEmbedAssertion(r, req)
	if err != nil {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embedDenyReason(err), peek.TokenID, s.embedMaterial().KeyID, peek.Issuer, peek.Subject)
		writeEmbedError(w, r, err)
		return
	}
	c := verified.Claims
	ws, tenant, err := s.store.ResolveWorkspace(r.Context(), c.TenantID, "", c.WorkbenchKey)
	if err != nil {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonWorkspace, c.TokenID, verified.KeyID, c.Issuer, c.Subject)
		writeIdentityError(w, r, err)
		return
	}
	if ws.Status != "active" || tenant.Status != "active" {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonWorkspace, c.TokenID, verified.KeyID, c.Issuer, c.Subject)
		WriteForbidden(w, r)
		return
	}
	if err := embed.BindVerifiedWorkspace(ws.ID, c); err != nil {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonTenancy, c.TokenID, verified.KeyID, c.Issuer, c.Subject)
		writeEmbedError(w, r, err)
		return
	}
	user, err := s.store.UpsertUser(r.Context(), c.Issuer, c.Subject, c.DisplayName)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if user.Status != "active" {
		s.auditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonPrincipal, c.TokenID, verified.KeyID, c.Issuer, c.Subject)
		WriteForbidden(w, r)
		return
	}
	policy := s.sec.sessionPolicy()
	issued, err := s.sessions.Create(r.Context(), user.ID, s.clockNow(), policy.IdleTimeout, policy.AbsoluteTimeout, session.CreateOpts{
		Binding: session.Binding{
			TenantID:     tenant.ID,
			WorkbenchKey: ws.WorkbenchKey,
			WorkspaceID:  ws.ID,
			Capabilities: append([]string(nil), c.Capabilities...),
		},
	})
	if err != nil {
		writeSessionError(w, r, err)
		return
	}
	s.issueSessionCookies(w, r, issued)
	s.auditSession(r, issued.Record, session.EventCreated, session.OutcomeAllowed, "embed exchange")
	s.auditEmbedTenancy(r, embed.EventExchanged, session.OutcomeAllowed, embed.ReasonIssued, c.TokenID, verified.KeyID, c.Issuer, c.Subject, tenant.ID, ws.WorkbenchKey, ws.ID)
	session := viewSession(issued.Record)
	attachEmbedChromeKnown(session.Embed, tenant, ws)
	writeJSON(w, http.StatusCreated, embedExchangeResponse{
		Session:      session,
		Principal:    user,
		CSRFToken:    issued.CSRF,
		Assertion:    embed.PublicViewFromClaims(c, verified.KeyID),
		Workspace:    ws,
		Tenant:       tenant,
		Capabilities: append([]string(nil), c.Capabilities...),
	})
}

// peekEmbedClaims decodes unverified JWT claims for audit fields only.
// Never use the result to resolve a workspace or authorize (ADV-008).
func peekEmbedClaims(token string) (embed.Claims, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return embed.Claims{}, embed.ErrSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return embed.Claims{}, embed.ErrSignature
	}
	var c embed.Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return embed.Claims{}, embed.ErrMissingClaim
	}
	return c, nil
}

func confirmMintBinding(req mintAssertionRequest, tenant identity.Tenant, ws identity.Workspace) error {
	if id := strings.TrimSpace(req.TenantID); id != "" && !strings.EqualFold(id, tenant.ID) {
		return authz.ErrWorkspaceIdentityMismatch
	}
	if key := strings.TrimSpace(req.WorkbenchKey); key != "" && key != ws.WorkbenchKey {
		return authz.ErrWorkspaceIdentityMismatch
	}
	return authz.ConfirmResolvedID(ws.ID, req.WorkspaceID)
}

func writeEmbedError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, embed.ErrMissingClaim), errors.Is(err, embed.ErrCapability),
		errors.Is(err, embed.ErrSDK), errors.Is(err, embed.ErrTTL),
		errors.Is(err, embed.ErrIssuer), errors.Is(err, embed.ErrSubject),
		errors.Is(err, embed.ErrTenant), errors.Is(err, embed.ErrWorkbench),
		errors.Is(err, embed.ErrTokenID), errors.Is(err, embed.ErrWorkspaceBinding):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The embed assertion is missing or has invalid claims.")
	case errors.Is(err, embed.ErrIssuerNotAllowed):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "The embed assertion issuer is not on the allowlist. Empty EMBED_ISSUER / EMBED_ISSUER_ALLOWLIST fails closed.")
	case errors.Is(err, embed.ErrHostIssuer):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "The embed assertion issuer is not bound to the minting host. Send X-FlowForge-Host-Issuer (or hostIssuer) set to the configured Portal or embed issuer for this frame — never a value peeked from the assertion.")
	case errors.Is(err, embed.ErrHostContext):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "X-FlowForge-Host-Context / hostContext must be portal or embed.")
	case errors.Is(err, embed.ErrAudience):
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", "The embed assertion audience is not bound to FlowForge.")
	case errors.Is(err, embed.ErrExpired), errors.Is(err, embed.ErrNotYetValid):
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", "The embed assertion is expired or not yet valid.")
	case errors.Is(err, embed.ErrSignature), errors.Is(err, embed.ErrUnknownKey):
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", "The embed assertion is not valid.")
	case errors.Is(err, embed.ErrReplay):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "The embed assertion has already been used.")
	case errors.Is(err, authz.ErrMintImpersonation):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Mint subject must match the authenticated caller unless embed.impersonate is granted.")
	case errors.Is(err, authz.ErrMintIssuerSpoof):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Mint issuer must match the authenticated caller.")
	case errors.Is(err, embed.ErrTenancyMismatch):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Host-supplied tenant or workbench does not match the embed session.")
	case errors.Is(err, embed.ErrBootstrap):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Embed sessions cannot create tenants or workspaces.")
	case errors.Is(err, embed.ErrOverlapUntilRequired):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "overlapUntil is required and must be in the future (max 4h).")
	case errors.Is(err, embed.ErrOverlapUntilTooLong):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "overlapUntil exceeds the maximum overlap window (4h).")
	case errors.Is(err, embed.ErrOverlapNotPrior):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Overlap registration is locked to the previous active signing key.")
	case errors.Is(err, embed.ErrKeyUnavailable), errors.Is(err, embed.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Embed signing is not available.")
	default:
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The embed request is not valid.")
	}
}

func embedSessionBound(r *http.Request) bool {
	pc := principalFromRequest(r)
	return pc != nil && pc.session != nil && pc.session.Binding.Bound()
}

func (s *Server) requireBootstrapAdmin(w http.ResponseWriter, r *http.Request, user identity.User) bool {
	if embed.DeniesBootstrap(embedSessionBound(r)) {
		if pc := principalFromRequest(r); pc != nil && pc.session != nil {
			s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "embed session cannot bootstrap")
		}
		writeEmbedError(w, r, embed.ErrBootstrap)
		return false
	}
	return s.requirePlatformAdmin(w, r, user)
}

func (s *Server) requirePlatformAdmin(w http.ResponseWriter, r *http.Request, user identity.User) bool {
	if authz.IsPlatformAdmin(user.Issuer, user.ExternalSubject, s.platformAdmins) {
		return true
	}
	if pc := principalFromRequest(r); pc != nil && pc.session != nil {
		s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "missing platform.administer")
	}
	WriteForbidden(w, r)
	return false
}

func embedDenyReason(err error) string {
	switch {
	case errors.Is(err, embed.ErrAudience):
		return embed.ReasonAudience
	case errors.Is(err, embed.ErrExpired):
		return embed.ReasonExpired
	case errors.Is(err, embed.ErrNotYetValid):
		return embed.ReasonNotYetValid
	case errors.Is(err, embed.ErrReplay):
		return embed.ReasonReplay
	case errors.Is(err, embed.ErrSignature), errors.Is(err, embed.ErrUnknownKey):
		return embed.ReasonSignature
	case errors.Is(err, embed.ErrTenancyMismatch):
		return embed.ReasonTenancy
	case errors.Is(err, embed.ErrIssuerNotAllowed), errors.Is(err, embed.ErrIssuer):
		return embed.ReasonIssuer
	case errors.Is(err, embed.ErrHostIssuer), errors.Is(err, embed.ErrHostContext):
		return embed.ReasonHostIssuer
	case errors.Is(err, embed.ErrCapability):
		return embed.ReasonCapability
	case errors.Is(err, embed.ErrMissingClaim), errors.Is(err, embed.ErrSDK):
		return embed.ReasonClaims
	default:
		return embed.ReasonRejected
	}
}

func (s *Server) verifyEmbedAssertion(r *http.Request, req exchangeAssertionRequest) (embed.Verified, error) {
	binding, err := embed.ResolveHostBinding(
		r.Header.Get(headerHostIssuer),
		r.Header.Get(headerHostContext),
		req.HostIssuer,
		req.HostContext,
	)
	if err != nil {
		return embed.Verified{}, err
	}
	opt := embed.VerifyOptions{
		Audience:            embed.DefaultAudience,
		Now:                 s.clockNow(),
		Consumer:            s.embedJTI,
		Context:             r.Context(),
		ExpectedHostIssuer:  binding.Issuer,
		HostContext:         binding.Context,
		EmbedIssuers:        s.embedMintIssuers,
		PortalIssuers:       s.portalIssuers,
		SelectPathAllowlist: true,
		NBFLeeway:           s.embedNBFLeeway,
	}
	if s.embedRing != nil {
		return s.embedRing.Verify(r.Context(), req.Assertion, opt)
	}
	return embed.Verify(s.embedMaterial(), req.Assertion, opt)
}

func (s *Server) embedMaterial() embed.Material {
	if s.embedRing != nil {
		return s.embedRing.MaterialAt(s.clockNow())
	}
	return s.embedKeys
}

func (s *Server) auditEmbed(r *http.Request, eventType, outcome, reason, jti, kid, issuer, subject string) {
	s.auditEmbedTenancy(r, eventType, outcome, reason, jti, kid, issuer, subject, "", "", "")
}

func (s *Server) auditEmbedTenancy(r *http.Request, eventType, outcome, reason, jti, kid, issuer, subject, tenantID, workbench, workspaceID string) {
	ev := embed.AuthzEvent{
		EventType:    eventType,
		Outcome:      outcome,
		Reason:       reason,
		JTI:          jti,
		Kid:          kid,
		Issuer:       issuer,
		Subject:      subject,
		TenantID:     tenantID,
		WorkbenchKey: workbench,
		WorkspaceID:  workspaceID,
		RequestID:    RequestIDFromContext(r.Context()),
	}
	if s.embedAuditor != nil {
		s.embedAuditor.Record(ev)
	}
	if s.log == nil {
		return
	}
	s.log.Info("embed_audit",
		"event_type", ev.EventType,
		"outcome", ev.Outcome,
		"reason", ev.Reason,
		"jti", ev.JTI,
		"kid", ev.Kid,
		"issuer", ev.Issuer,
		"subject", ev.Subject,
		"tenant_id", ev.TenantID,
		"workbench_key", ev.WorkbenchKey,
		"workspace_id", ev.WorkspaceID,
		"request_id", ev.RequestID,
	)
}

func (s *Server) allowEmbedExchange(r *http.Request, issuer, subject string) bool {
	if s.embedLimiter == nil {
		return false
	}
	now := s.clockNow()
	limits := s.embedLimiter.Limits()
	if !s.embedLimiter.Allow(embed.IPKey(s.requestClientIP(r)), limits.ExchangeIP, now) {
		return false
	}
	if key := embed.PrincipalKey(issuer, subject); key != "" {
		if !s.embedLimiter.Allow(key, limits.ExchangePrincipal, now) {
			return false
		}
	}
	return true
}

func (s *Server) allowEmbedMint(r *http.Request, issuer, subject string) bool {
	if s.embedLimiter == nil {
		return false
	}
	key := embed.PrincipalKey(issuer, subject)
	if key == "" {
		key = embed.IPKey(s.requestClientIP(r))
	}
	return s.embedLimiter.Allow("mint:"+key, s.embedLimiter.Limits().MintPrincipal, s.clockNow())
}

func (s *Server) writeEmbedRateLimited(w http.ResponseWriter, r *http.Request, detail string) {
	retry := embed.DefaultRateWindow
	if s.embedLimiter != nil {
		retry = s.embedLimiter.RetryAfter(s.clockNow())
	}
	secs := int(retry.Seconds())
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	WriteProblem(w, r, http.StatusTooManyRequests, CodeRateLimited, "Rate Limited", detail)
}

func (s *Server) requestClientIP(r *http.Request) string {
	if s.sec.fromTrustedProxy(r) {
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			part := strings.TrimSpace(strings.Split(xff, ",")[0])
			if ip := net.ParseIP(part); ip != nil {
				return ip.String()
			}
		}
	}
	if ip := clientIP(r); ip != nil {
		return ip.String()
	}
	return "unknown"
}
