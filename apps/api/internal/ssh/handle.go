package ssh

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	cryptossh "golang.org/x/crypto/ssh"
)

// Handle is the ephemeral worker credential reference. JSON serialization
// never includes privateKey, passphrase, or signer material.
type Handle struct {
	ID           string    `json:"id"`
	SSHTargetID  string    `json:"sshTargetId"`
	CredentialID string    `json:"credentialId,omitempty"`
	Username     string    `json:"username,omitempty"`
	ExpiresAt    time.Time `json:"expiresAt"`
	signer       cryptossh.Signer
}

// Public is the only handle representation allowed in jobs, logs, and APIs.
func (h Handle) Public() map[string]any {
	out := map[string]any{
		"id":          h.ID,
		"sshTargetId": h.SSHTargetID,
		"expiresAt":   h.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if h.CredentialID != "" {
		out["credentialId"] = h.CredentialID
	}
	if h.Username != "" {
		out["username"] = h.Username
	}
	return out
}

// MarshalJSON implements json.Marshaler without private key material.
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

// Signer returns the in-memory key. Callers must not log it.
func (h *Handle) Signer() (cryptossh.Signer, error) {
	if h == nil || h.signer == nil {
		return nil, engineError(CodeHandleForbidden, "credential handle has no signer", http.StatusForbidden)
	}
	if h.Expired(time.Now().UTC()) {
		return nil, engineError(CodeHandleForbidden, "credential handle has expired", http.StatusForbidden)
	}
	return h.signer, nil
}

// BindSigner attaches an in-memory signer. The signer is not exported.
func (h *Handle) BindSigner(signer cryptossh.Signer) {
	if h == nil {
		return
	}
	h.signer = signer
}

// NewHandleFromPrivateKey builds a handle from vault Unlock bytes. The
// private key and passphrase are parsed and discarded from the returned value.
func NewHandleFromPrivateKey(id, targetID, credentialID, username string, plain []byte, expires time.Time) (*Handle, error) {
	key, passphrase, err := ExtractPrivateKey(plain)
	if err != nil {
		return nil, err
	}
	signer, err := parseSigner(key, passphrase)
	if err != nil {
		return nil, err
	}
	user, err := NormalizeUsername(username, username != "")
	if err != nil {
		return nil, engineError(CodeRootDenied, err.Error(), http.StatusForbidden)
	}
	return &Handle{
		ID:           strings.TrimSpace(id),
		SSHTargetID:  strings.TrimSpace(targetID),
		CredentialID: strings.TrimSpace(credentialID),
		Username:     user,
		ExpiresAt:    expires.UTC(),
		signer:       signer,
	}, nil
}

func parseSigner(key, passphrase []byte) (cryptossh.Signer, error) {
	if len(key) == 0 {
		return nil, engineError(CodeCredentialDenied, "SSH targets require a workspace ssh_private_key credential.", http.StatusBadRequest)
	}
	if len(passphrase) > 0 {
		signer, err := cryptossh.ParsePrivateKeyWithPassphrase(key, passphrase)
		if err != nil {
			return nil, engineError(CodeHandleForbidden, "private key could not be parsed", http.StatusForbidden)
		}
		return signer, nil
	}
	signer, err := cryptossh.ParsePrivateKey(key)
	if err != nil {
		return nil, engineError(CodeHandleForbidden, "private key could not be parsed", http.StatusForbidden)
	}
	return signer, nil
}

// ExtractPrivateKey pulls privateKey / passphrase from vault Unlock JSON.
func ExtractPrivateKey(plain []byte) (key, passphrase []byte, err error) {
	plain = bytesTrimSpace(plain)
	if len(plain) == 0 {
		return nil, nil, engineError(CodeHandleForbidden, "credential payload is empty", http.StatusForbidden)
	}
	if len(plain) > 0 && plain[0] == '{' {
		var obj map[string]string
		if err := json.Unmarshal(plain, &obj); err != nil {
			return nil, nil, engineError(CodeHandleForbidden, "credential payload could not be parsed", http.StatusForbidden)
		}
		pk := strings.TrimSpace(obj[CredentialSecretFieldPrivateKey])
		if pk == "" {
			return nil, nil, engineError(CodeHandleForbidden, "credential is missing privateKey", http.StatusForbidden)
		}
		return []byte(pk), []byte(obj[CredentialSecretFieldPassphrase]), nil
	}
	return plain, nil, nil
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}
