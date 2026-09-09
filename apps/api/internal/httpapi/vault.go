package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

type createCredentialRequest struct {
	ID             string            `json:"id"`
	WorkspaceID    string            `json:"workspace_id"`
	WorkspaceIDAlt string            `json:"workspaceId"`
	Type           string            `json:"type"`
	DisplayName    string            `json:"displayName"`
	Tags           []string          `json:"tags"`
	Metadata       map[string]string `json:"metadata"`
	ExpiresAt      string            `json:"expiresAt"`
	Secret         map[string]string `json:"secret"`
}

type updateCredentialRequest struct {
	ID             string             `json:"id"`
	WorkspaceID    string             `json:"workspace_id"`
	WorkspaceIDAlt string             `json:"workspaceId"`
	DisplayName    *string            `json:"displayName"`
	Tags           *[]string          `json:"tags"`
	Metadata       *map[string]string `json:"metadata"`
	ExpiresAt      *string            `json:"expiresAt"`
	Secret         map[string]string  `json:"secret"`
}

type rotateCredentialRequest struct {
	ID             string            `json:"id"`
	WorkspaceID    string            `json:"workspace_id"`
	WorkspaceIDAlt string            `json:"workspaceId"`
	Secret         map[string]string `json:"secret"`
}

type deleteCredentialRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Confirm        bool   `json:"confirm"`
}

func (s *Server) requireVault(w http.ResponseWriter, r *http.Request) bool {
	if s.vault != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Credential vault is not available.")
	return false
}

func (s *Server) vaultScope(w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !s.requireVault(w, r) {
		return isolation.Scope{}, false
	}
	return s.requireScope(w, r, user, perm)
}

func (s *Server) getCredentialCatalog(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.vaultScope(w, r, authz.PermCredentialView)
	if !ok {
		return
	}
	_ = scope
	writeJSON(w, http.StatusOK, vault.TypeCatalog())
}

func (s *Server) listCredentials(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireVault(w, r) {
		return
	}
	ws, _, _, perms, ok := s.requireAccess(w, r, user, authz.PermCredentialView)
	if !ok {
		return
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	items, err := s.vault.List(r.Context(), scope)
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	for i := range items {
		items[i].PermittedActions = permittedCredentialActions(perms)
	}
	writeJSON(w, http.StatusOK, listResponse[vault.Metadata]{Items: items})
}

func (s *Server) createCredential(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.vaultScope(w, r, authz.PermCredentialManage)
	if !ok {
		return
	}
	var req createCredentialRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	meta, err := s.vault.Create(r.Context(), scope, vault.CreateInput{
		Type:        req.Type,
		DisplayName: req.DisplayName,
		Tags:        req.Tags,
		Metadata:    req.Metadata,
		ExpiresAt:   req.ExpiresAt,
		Secret:      req.Secret,
	})
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	meta.PermittedActions = []string{"view", "use", "test", "rotate", "disable", "enable", "delete", "manage"}
	if leak := credentialLeak(meta, req.Secret); leak != "" {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	writeJSON(w, http.StatusCreated, meta)
}

func (s *Server) getCredential(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, perms []string) {
		meta, err := s.vault.Get(r.Context(), scope, id)
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		writeJSON(w, http.StatusOK, meta)
	})
}

func (s *Server) updateCredential(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		var req updateCredentialRequest
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if len(req.Secret) > 0 {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Secret material can only be sent to create or rotate.")
			return
		}
		meta, err := s.vault.Update(r.Context(), scope, id, vault.UpdateInput{
			DisplayName: req.DisplayName,
			Tags:        req.Tags,
			Metadata:    req.Metadata,
			ExpiresAt:   req.ExpiresAt,
		})
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		writeJSON(w, http.StatusOK, meta)
	})
}

func (s *Server) rotateCredential(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		var req rotateCredentialRequest
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		meta, err := s.vault.Rotate(r.Context(), scope, id, vault.RotateInput{Secret: req.Secret})
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		if leak := credentialLeak(meta, req.Secret); leak != "" {
			WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
			return
		}
		writeJSON(w, http.StatusOK, meta)
	})
}

func (s *Server) disableCredential(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		meta, err := s.vault.Disable(r.Context(), scope, id)
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		writeJSON(w, http.StatusOK, meta)
	})
}

func (s *Server) enableCredential(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		meta, err := s.vault.Enable(r.Context(), scope, id)
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		writeJSON(w, http.StatusOK, meta)
	})
}

func (s *Server) testCredential(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireVault(w, r) {
		return
	}
	ws, _, _, perms, ok := s.requireAccess(w, r, user, "")
	if !ok {
		return
	}
	if !authz.Allows(perms, authz.PermCredentialUse) && !authz.Allows(perms, authz.PermCredentialManage) {
		WriteForbidden(w, r)
		return
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	id := strings.TrimSpace(r.PathValue("credentialId"))
	result, meta, err := s.vault.Test(r.Context(), scope, id)
	if err != nil && meta.ID == "" {
		writeVaultError(w, r, err)
		return
	}
	meta.PermittedActions = permittedCredentialActions(perms)
	writeJSON(w, http.StatusOK, map[string]any{"result": result, "credential": meta})
}

func (s *Server) useVaultCredential(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialUse, func(scope isolation.Scope, id string, _ []string) {
		if err := s.vault.Use(r.Context(), scope, id); err != nil {
			writeVaultError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func (s *Server) getCredentialUsage(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, _ []string) {
		usage, err := s.vault.Usage(r.Context(), scope, id)
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, usage)
	})
}

func (s *Server) getCredentialDeletionImpact(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, _ []string) {
		impact, err := s.vault.DeletionImpact(r.Context(), scope, id)
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, impact)
	})
}

func (s *Server) deleteCredential(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, _ []string) {
		var req deleteCredentialRequest
		if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
			if !DecodeJSON(w, r, &req) {
				return
			}
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if err := s.vault.Delete(r.Context(), scope, id, vault.DeleteInput{Confirm: req.Confirm}); err != nil {
			writeVaultError(w, r, err)
			return
		}
		if s.scoped != nil {
			_, _ = s.scoped.Create(r.Context(), scope, isolation.Record{
				Kind: isolation.KindAudit,
				Name: "credential.deleted",
				Metadata: map[string]any{
					"resource_type": "credential",
					"resource_id":   id,
					"action":        "deleted",
				},
			})
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func (s *Server) listCredentialEvents(w http.ResponseWriter, r *http.Request) {
	s.withCredential(w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, _ []string) {
		items, err := s.vault.Events(r.Context(), scope, id)
		if err != nil {
			writeVaultError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, listResponse[vault.Event]{Items: items})
	})
}

func (s *Server) withCredential(w http.ResponseWriter, r *http.Request, perm string, fn func(isolation.Scope, string, []string)) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireVault(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("credentialId"))
	if id == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "credentialId is required.")
		return
	}
	ws, _, _, perms, ok := s.requireAccess(w, r, user, perm)
	if !ok {
		return
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	fn(scope, id, perms)
}

func permittedCredentialActions(perms []string) []string {
	var out []string
	if authz.Allows(perms, authz.PermCredentialView) {
		out = append(out, "view")
	}
	if authz.Allows(perms, authz.PermCredentialUse) {
		out = append(out, "use", "test")
	}
	if authz.Allows(perms, authz.PermCredentialManage) {
		if !containsString(out, "test") {
			out = append(out, "test")
		}
		out = append(out, "rotate", "disable", "enable", "delete", "manage")
	}
	return out
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func credentialLeak(meta vault.Metadata, secret map[string]string) string {
	raw, err := json.Marshal(meta)
	if err != nil {
		return "marshal"
	}
	body := string(raw)
	for _, v := range secret {
		v = strings.TrimSpace(v)
		if len(v) >= 8 && strings.Contains(body, v) {
			return v
		}
	}
	lower := strings.ToLower(body)
	for _, banned := range []string{"ciphertext", "dek_envelope", "dekenvelope"} {
		if strings.Contains(lower, banned) {
			return banned
		}
	}
	return ""
}

func writeVaultError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, vault.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, vault.ErrInUse):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Credential is referenced by an active execution.")
	case errors.Is(err, vault.ErrNotConfirmed):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Deletion requires confirm=true after reviewing deletion impact.")
	case errors.Is(err, vault.ErrDisabled):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Credential is disabled.")
	case errors.Is(err, vault.ErrExpired):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Credential is expired.")
	case errors.Is(err, vault.ErrKeyUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Credential encryption key is not configured.")
	case errors.Is(err, vault.ErrDecrypt):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Stored credential payload could not be decrypted.")
	case errors.Is(err, vault.ErrInvalid), errors.Is(err, vault.ErrNoScope):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", err.Error())
	default:
		if err != nil && !errors.Is(err, vault.ErrKeyUnavailable) {
			msg := err.Error()
			if strings.Contains(strings.ToLower(msg), "required") || strings.Contains(msg, "type") || strings.Contains(msg, "tag") || strings.Contains(msg, "metadata") || strings.Contains(msg, "displayName") || strings.Contains(msg, "expiresAt") || strings.Contains(msg, "RFC3339") {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", msg)
				return
			}
		}
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
