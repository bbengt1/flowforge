package scripts

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Handle is a scoped, short-lived credential reference. JSON serialization
// never includes plaintext secrets, tokens, or kubeconfig.
type Handle struct {
	ID           string    `json:"id"`
	CredentialID string    `json:"credentialId,omitempty"`
	WorkspaceID  string    `json:"workspaceId,omitempty"`
	Scopes       []string  `json:"scopes,omitempty"`
	ExpiresAt    time.Time `json:"expiresAt"`
	secret       []byte
}

// Public is the only handle representation allowed in jobs, env, logs, and APIs.
func (h Handle) Public() map[string]any {
	out := map[string]any{
		"id":        h.ID,
		"expiresAt": h.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if h.CredentialID != "" {
		out["credentialId"] = h.CredentialID
	}
	if h.WorkspaceID != "" {
		out["workspaceId"] = h.WorkspaceID
	}
	if len(h.Scopes) > 0 {
		out["scopes"] = append([]string(nil), h.Scopes...)
	}
	return out
}

// MarshalJSON implements json.Marshaler without secret material.
func (h Handle) MarshalJSON() ([]byte, error) {
	return json.Marshal(h.Public())
}

// Expired reports whether the handle is past its bound expiry.
func (h Handle) Expired(now time.Time) bool {
	if h.ExpiresAt.IsZero() {
		return true
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return !now.Before(h.ExpiresAt)
}

// Secret returns the in-memory payload. Callers must not log it.
func (h *Handle) Secret() ([]byte, error) {
	if h == nil || len(h.secret) == 0 {
		return nil, engineError(CodeHandleForbidden, "credential handle has no secret material.", http.StatusForbidden)
	}
	if h.Expired(time.Now().UTC()) {
		return nil, engineError(CodeHandleForbidden, "credential handle has expired.", http.StatusForbidden)
	}
	return h.secret, nil
}

// NewHandle builds a scoped handle. plaintext is bound in-memory only.
func NewHandle(id, credentialID, workspaceID string, scopes []string, expires time.Time, plaintext []byte) (*Handle, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, engineError(CodeHandleForbidden, "credential handle id is required.", http.StatusForbidden)
	}
	if irredactableSecret([]byte(id)) || secretInputKeys[strings.ToLower(id)] {
		return nil, engineError(CodeHandleForbidden, "credential handle id must not contain secret material.", http.StatusForbidden)
	}
	if len(scopes) == 0 {
		return nil, engineError(CodeHandleForbidden, "credential handle must declare at least one scope.", http.StatusForbidden)
	}
	for _, scope := range scopes {
		if strings.TrimSpace(scope) == "" || secretInputKeys[strings.ToLower(scope)] {
			return nil, engineError(CodeHandleForbidden, "credential handle scopes are invalid.", http.StatusForbidden)
		}
	}
	now := time.Now().UTC()
	if expires.IsZero() {
		expires = now.Add(time.Duration(DefaultHandleTTL) * time.Second)
	}
	expires = expires.UTC()
	if !expires.After(now) {
		return nil, engineError(CodeHandleForbidden, "credential handle has expired.", http.StatusForbidden)
	}
	if expires.Sub(now) > time.Duration(MaxHandleTTL)*time.Second {
		return nil, engineError(CodeHandleForbidden, "credential handle TTL exceeds the 5 minute cap.", http.StatusForbidden)
	}
	h := &Handle{
		ID:           id,
		CredentialID: strings.TrimSpace(credentialID),
		WorkspaceID:  strings.TrimSpace(workspaceID),
		Scopes:       append([]string(nil), scopes...),
		ExpiresAt:    expires,
		secret:       append([]byte(nil), plaintext...),
	}
	if err := rejectPublicSecret(h.Public()); err != nil {
		return nil, err
	}
	return h, nil
}

// PublicHandles validates and projects handles for runner injection.
func PublicHandles(handles []Handle, now time.Time) ([]map[string]any, error) {
	if len(handles) == 0 {
		return nil, nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	out := make([]map[string]any, 0, len(handles))
	for i := range handles {
		h := handles[i]
		if strings.TrimSpace(h.ID) == "" || len(h.Scopes) == 0 {
			return nil, engineError(CodeHandleForbidden, "credential handle is missing id or scope.", http.StatusForbidden)
		}
		if h.Expired(now) {
			return nil, engineError(CodeHandleForbidden, "credential handle has expired.", http.StatusForbidden)
		}
		pub := h.Public()
		if err := rejectPublicSecret(pub); err != nil {
			return nil, err
		}
		out = append(out, pub)
	}
	return out, nil
}

func rejectPublicSecret(pub map[string]any) error {
	raw, err := json.Marshal(pub)
	if err != nil {
		return engineError(CodeHandleForbidden, "credential handle could not be projected.", http.StatusForbidden)
	}
	if irredactableSecret(raw) {
		return engineError(CodeHandleForbidden, "credential handle projection contained secret material.", http.StatusForbidden)
	}
	if _, changed := redactTokens(string(raw)); changed {
		return engineError(CodeHandleForbidden, "credential handle projection contained secret material.", http.StatusForbidden)
	}
	for k := range pub {
		if secretInputKeys[strings.ToLower(strings.ReplaceAll(k, "-", ""))] {
			return engineError(CodeHandleForbidden, "credential handle projection contained a secret key.", http.StatusForbidden)
		}
	}
	return nil
}
