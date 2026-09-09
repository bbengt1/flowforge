package kubernetes

import (
	"encoding/json"
	"net/http"
	"time"
)

// Handle is the ephemeral worker credential reference. JSON serialization
// never includes kubeconfig or REST material.
type Handle struct {
	ID              string         `json:"id"`
	ClusterTargetID string         `json:"clusterTargetId"`
	CredentialID    string         `json:"credentialId,omitempty"`
	ExpiresAt       time.Time      `json:"expiresAt"`
	ServiceAccount  map[string]any `json:"serviceAccount,omitempty"`
	rest            *RESTConfig
}

// Public is the only handle representation allowed in jobs, logs, and APIs.
func (h Handle) Public() map[string]any {
	out := map[string]any{
		"id":              h.ID,
		"clusterTargetId": h.ClusterTargetID,
		"expiresAt":       h.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if h.CredentialID != "" {
		out["credentialId"] = h.CredentialID
	}
	if len(h.ServiceAccount) > 0 {
		out["serviceAccount"] = RedactValue(h.ServiceAccount)
	}
	return out
}

// MarshalJSON implements json.Marshaler without REST/kubeconfig fields.
func (h Handle) MarshalJSON() ([]byte, error) {
	return json.Marshal(h.Public())
}

// Expired reports whether the handle is past its bound expiry.
func (h Handle) Expired(now time.Time) bool {
	if h.ExpiresAt.IsZero() {
		return false
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return !now.Before(h.ExpiresAt)
}

// BindREST attaches in-memory REST config. The config is not exported.
func (h *Handle) BindREST(cfg RESTConfig) {
	if h == nil {
		return
	}
	cp := cfg
	h.rest = &cp
}

// Client builds a LiveClient from the bound REST config.
func (h *Handle) Client() (ClusterClient, error) {
	if h == nil || h.rest == nil {
		return nil, engineError(CodeMissingClient, "credential handle has no cluster client", http.StatusForbidden)
	}
	if h.Expired(time.Now().UTC()) {
		return nil, engineError(CodeHandleForbidden, "credential handle has expired", http.StatusForbidden)
	}
	return NewLiveClient(*h.rest)
}

// NewHandleFromKubeconfig builds a handle from vault Unlock bytes. The
// kubeconfig bytes are parsed and discarded from the returned value.
func NewHandleFromKubeconfig(id, targetID, credentialID string, plain []byte, expires time.Time) (*Handle, error) {
	kc, err := ExtractKubeconfig(plain)
	if err != nil {
		return nil, err
	}
	cfg, err := ParseKubeconfig(kc)
	if err != nil {
		return nil, err
	}
	h := &Handle{
		ID:              id,
		ClusterTargetID: targetID,
		CredentialID:    credentialID,
		ExpiresAt:       expires.UTC(),
	}
	h.BindREST(cfg)
	return h, nil
}
