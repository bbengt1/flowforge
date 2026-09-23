package core

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/mfa"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const mfaVerifyLimit = 8

type MfaStatus struct {
	Method                string   `json:"method"`
	Enrolled              bool     `json:"enrolled"`
	Satisfied             bool     `json:"satisfied"`
	Applicable            bool     `json:"applicable"`
	PrivilegedPermissions []string `json:"privileged_permissions"`
	OTPAuthURI            string   `json:"otpauth_uri,omitempty"`
}

func (s *Server) getSessionMFA(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	status, err := s.MfaStatus(r, user.ID, user.ExternalSubject, false)
	if err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, status)
}

func (s *Server) postSessionMFAEnroll(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !decodeEmptyOrCodeFree(w, r, true) {
		return
	}
	if !s.mfaKeyReady() {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	if s.MFA == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	secret, err := mfa.GenerateSecret()
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	defer clearBytes(secret)
	blob, err := mfa.Seal(s.MFAKey, secret)
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	if err := s.MFA.PutPending(r.Context(), user.ID, blob, s.ClockNow()); err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	status, err := s.MfaStatus(r, user.ID, user.ExternalSubject, false)
	if err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	status.OTPAuthURI = mfa.ProvisioningURI(secret, user.ExternalSubject)
	WriteJSON(w, http.StatusOK, status)
}

func (s *Server) postSessionMFAVerify(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	code, ok := decodeMFACode(w, r)
	if !ok {
		return
	}
	if !s.mfaKeyReady() || s.MFA == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	allowed, retry, rateErr := s.allowMFAVerify(r, user.ID)
	if rateErr != nil {
		WriteRateStoreUnavailable(w, r)
		return
	}
	if !allowed {
		s.AuditLoginRejected(r, "rate-limited")
		WriteRateLimited(w, r, retry, "Login rate limit exceeded. Retry after the configured window.")
		return
	}
	factor, err := s.MFA.Get(r.Context(), user.ID)
	if err != nil {
		if errors.Is(err, mfa.ErrNotFound) {
			WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", InvalidCredentialsDetail)
			return
		}
		s.writeMFAStoreError(w, r, err)
		return
	}
	secret, err := mfa.Open(s.MFAKey, factor.Ciphertext)
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	defer clearBytes(secret)
	step, err := mfa.Match(secret, code, s.ClockNow(), factor.LastStep)
	if err != nil {
		s.AuditLoginRejected(r, "mfa rejected")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", InvalidCredentialsDetail)
		return
	}
	if err := s.MFA.Accept(r.Context(), user.ID, step, true, s.ClockNow()); err != nil {
		s.AuditLoginRejected(r, "mfa rejected")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", InvalidCredentialsDetail)
		return
	}
	pc := PrincipalFromRequest(r)
	if pc == nil || pc.Token == "" || s.Sessions == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Session store is not available.")
		return
	}
	if err := s.Sessions.MarkMFAVerified(r.Context(), pc.Token, s.ClockNow()); err != nil {
		writeSessionError(w, r, err)
		return
	}
	status, err := s.MfaStatus(r, user.ID, user.ExternalSubject, true)
	if err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, status)
}

// allowMFAGrant denies privileged permissions on local-login and OIDC
// sessions until TOTP step-up. Machine, trusted-dev, embed, and header
// identity are not subjects of this gate.
func (s *Server) allowMFAGrant(w http.ResponseWriter, r *http.Request, action string) bool {
	if !authz.MFARequired(action) {
		return true
	}
	pc := PrincipalFromRequest(r)
	if pc == nil || pc.Session == nil || pc.Session.Binding.Bound() || !session.RequiresMFA(pc.Session.AuthMethod) {
		return true
	}
	if s.MFA == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return false
	}
	factor, err := s.MFA.Get(r.Context(), pc.User.ID)
	enrolled := err == nil && factor.Confirmed
	if err != nil && !errors.Is(err, mfa.ErrNotFound) {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return false
	}
	if !enrolled {
		s.AuditSession(r, *pc.Session, session.EventPrivilegeDenied, session.OutcomeDenied, "mfa required")
		WriteProblem(w, r, http.StatusForbidden, CodeMFARequired, "MFA Required", "Enroll and verify MFA before using this permission.")
		return false
	}
	if pc.Session.MFAVerifiedAt == nil {
		if !s.mfaKeyReady() {
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
			return false
		}
		s.AuditSession(r, *pc.Session, session.EventPrivilegeDenied, session.OutcomeDenied, "mfa required")
		WriteProblem(w, r, http.StatusForbidden, CodeMFARequired, "MFA Required", "Verify MFA before using this permission.")
		return false
	}
	return true
}

func (s *Server) MfaStatus(r *http.Request, userID, account string, satisfiedOverride bool) (MfaStatus, error) {
	_ = account
	pc := PrincipalFromRequest(r)
	applicable := pc != nil && pc.Session != nil && !pc.Session.Binding.Bound() && session.RequiresMFA(pc.Session.AuthMethod)
	status := MfaStatus{
		Method:                "totp",
		Applicable:            applicable,
		PrivilegedPermissions: authz.MFAPrivilegedPermissions(),
	}
	if !applicable {
		status.Satisfied = true
		return status, nil
	}
	if satisfiedOverride || (pc.Session.MFAVerifiedAt != nil) {
		status.Satisfied = true
	}
	if s.MFA == nil {
		return MfaStatus{}, mfa.ErrUnavailable
	}
	factor, err := s.MFA.Get(r.Context(), userID)
	if err != nil {
		if errors.Is(err, mfa.ErrNotFound) {
			return status, nil
		}
		return MfaStatus{}, err
	}
	status.Enrolled = factor.Confirmed
	return status, nil
}

func (s *Server) mfaKeyReady() bool {
	return len(s.MFAKey) == 32
}

func (s *Server) allowMFAVerify(r *http.Request, userID string) (bool, time.Duration, error) {
	if s.LoginLimiter == nil {
		return false, time.Minute, nil
	}
	return s.LoginLimiter.Decide(r.Context(), "mfa:"+userID, mfaVerifyLimit, s.ClockNow())
}

func (s *Server) writeMFAStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, mfa.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "MFA is already enrolled.")
	case errors.Is(err, mfa.ErrNotConfigured), errors.Is(err, mfa.ErrUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
	default:
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
	}
}

func decodeMFACode(w http.ResponseWriter, r *http.Request) (string, bool) {
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return "", false
	}
	var code string
	for key, value := range raw {
		norm := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
		if norm != "code" {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "MFA verify accepts code.")
			return "", false
		}
		code, _ = value.(string)
	}
	code = strings.TrimSpace(code)
	if code == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "code is required.")
		return "", false
	}
	return code, true
}

func decodeEmptyOrCodeFree(w http.ResponseWriter, r *http.Request, allowEmpty bool) bool {
	if allowEmpty && (r.Body == nil || r.ContentLength == 0) && strings.TrimSpace(r.Header.Get("Content-Type")) == "" {
		return true
	}
	var raw map[string]any
	if !DecodeJSON(w, r, &raw) {
		return false
	}
	if len(raw) != 0 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "MFA enroll takes an empty object.")
		return false
	}
	return true
}

func clearBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
