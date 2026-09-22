package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/mfa"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const mfaVerifyLimit = 8

type mfaStatus struct {
	Method                string   `json:"method"`
	Enrolled              bool     `json:"enrolled"`
	Satisfied             bool     `json:"satisfied"`
	Applicable            bool     `json:"applicable"`
	PrivilegedPermissions []string `json:"privileged_permissions"`
	OTPAuthURI            string   `json:"otpauth_uri,omitempty"`
}

func (s *Server) getSessionMFA(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	status, err := s.mfaStatus(r, user.ID, user.ExternalSubject, false)
	if err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) postSessionMFAEnroll(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
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
	if s.mfa == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	secret, err := mfa.GenerateSecret()
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	defer clearBytes(secret)
	blob, err := mfa.Seal(s.mfaKey, secret)
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	if err := s.mfa.PutPending(r.Context(), user.ID, blob, s.clockNow()); err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	status, err := s.mfaStatus(r, user.ID, user.ExternalSubject, false)
	if err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	status.OTPAuthURI = mfa.ProvisioningURI(secret, user.ExternalSubject)
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) postSessionMFAVerify(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	code, ok := decodeMFACode(w, r)
	if !ok {
		return
	}
	if !s.mfaKeyReady() || s.mfa == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	if !s.allowMFAVerify(r, user.ID) {
		s.auditLoginRejected(r, "rate-limited")
		s.writeLoginRateLimited(w, r)
		return
	}
	factor, err := s.mfa.Get(r.Context(), user.ID)
	if err != nil {
		if errors.Is(err, mfa.ErrNotFound) {
			WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
			return
		}
		s.writeMFAStoreError(w, r, err)
		return
	}
	secret, err := mfa.Open(s.mfaKey, factor.Ciphertext)
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return
	}
	defer clearBytes(secret)
	step, err := mfa.Match(secret, code, s.clockNow(), factor.LastStep)
	if err != nil {
		s.auditLoginRejected(r, "mfa rejected")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	if err := s.mfa.Accept(r.Context(), user.ID, step, true, s.clockNow()); err != nil {
		s.auditLoginRejected(r, "mfa rejected")
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", invalidCredentialsDetail)
		return
	}
	pc := principalFromRequest(r)
	if pc == nil || pc.token == "" || s.sessions == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Session store is not available.")
		return
	}
	if err := s.sessions.MarkMFAVerified(r.Context(), pc.token, s.clockNow()); err != nil {
		writeSessionError(w, r, err)
		return
	}
	status, err := s.mfaStatus(r, user.ID, user.ExternalSubject, true)
	if err != nil {
		s.writeMFAStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// allowMFAGrant denies privileged permissions on local-login and OIDC
// sessions until TOTP step-up. Machine, trusted-dev, embed, and header
// identity are not subjects of this gate.
func (s *Server) allowMFAGrant(w http.ResponseWriter, r *http.Request, action string) bool {
	if !authz.MFARequired(action) {
		return true
	}
	pc := principalFromRequest(r)
	if pc == nil || pc.session == nil || pc.session.Binding.Bound() || !session.RequiresMFA(pc.session.AuthMethod) {
		return true
	}
	if s.mfa == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return false
	}
	factor, err := s.mfa.Get(r.Context(), pc.user.ID)
	enrolled := err == nil && factor.Confirmed
	if err != nil && !errors.Is(err, mfa.ErrNotFound) {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
		return false
	}
	if !enrolled {
		s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "mfa required")
		WriteProblem(w, r, http.StatusForbidden, CodeMFARequired, "MFA Required", "Enroll and verify MFA before using this permission.")
		return false
	}
	if pc.session.MFAVerifiedAt == nil {
		if !s.mfaKeyReady() {
			WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "MFA is not configured.")
			return false
		}
		s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "mfa required")
		WriteProblem(w, r, http.StatusForbidden, CodeMFARequired, "MFA Required", "Verify MFA before using this permission.")
		return false
	}
	return true
}

func (s *Server) mfaStatus(r *http.Request, userID, account string, satisfiedOverride bool) (mfaStatus, error) {
	_ = account
	pc := principalFromRequest(r)
	applicable := pc != nil && pc.session != nil && !pc.session.Binding.Bound() && session.RequiresMFA(pc.session.AuthMethod)
	status := mfaStatus{
		Method:                "totp",
		Applicable:            applicable,
		PrivilegedPermissions: authz.MFAPrivilegedPermissions(),
	}
	if !applicable {
		status.Satisfied = true
		return status, nil
	}
	if satisfiedOverride || (pc.session.MFAVerifiedAt != nil) {
		status.Satisfied = true
	}
	if s.mfa == nil {
		return mfaStatus{}, mfa.ErrUnavailable
	}
	factor, err := s.mfa.Get(r.Context(), userID)
	if err != nil {
		if errors.Is(err, mfa.ErrNotFound) {
			return status, nil
		}
		return mfaStatus{}, err
	}
	status.Enrolled = factor.Confirmed
	return status, nil
}

func (s *Server) mfaKeyReady() bool {
	return len(s.mfaKey) == 32
}

func (s *Server) allowMFAVerify(r *http.Request, userID string) bool {
	if s.loginLimiter == nil {
		return false
	}
	return s.loginLimiter.Allow("mfa:"+userID, mfaVerifyLimit, s.clockNow())
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
