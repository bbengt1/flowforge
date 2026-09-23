package vaulthttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
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

func RequireVault(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.Vault != nil {
		return true
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Credential vault is not available.")
	return false
}

func vaultScope(s *core.Server, w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !RequireVault(s, w, r) {
		return isolation.Scope{}, false
	}
	return s.RequireScope(w, r, user, perm)
}

func getCredentialCatalog(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := vaultScope(s, w, r, authz.PermCredentialView)
	if !ok {
		return
	}
	_ = scope
	core.WriteJSON(w, http.StatusOK, vault.TypeCatalog())
}

func listCredentials(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !RequireVault(s, w, r) {
		return
	}
	ws, _, _, perms, ok := s.RequireAccess(w, r, user, authz.PermCredentialView)
	if !ok {
		return
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, ws.TenantID, ws.WorkbenchKey)
	if err != nil {
		WriteVaultError(w, r, err)
		return
	}
	q, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	items, next, err := s.Vault.ListPage(r.Context(), scope, q)
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteVaultError(w, r, err)
		return
	}
	for i := range items {
		items[i].PermittedActions = permittedCredentialActions(perms)
	}
	core.WritePage(w, items, q, next)
}

func createCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := vaultScope(s, w, r, authz.PermCredentialManage)
	if !ok {
		return
	}
	var req createCredentialRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	meta, err := s.Vault.Create(r.Context(), scope, vault.CreateInput{
		Type:        req.Type,
		DisplayName: req.DisplayName,
		Tags:        req.Tags,
		Metadata:    req.Metadata,
		ExpiresAt:   req.ExpiresAt,
		Secret:      req.Secret,
	})
	if err != nil {
		WriteVaultError(w, r, err)
		return
	}
	meta.PermittedActions = []string{"view", "use", "test", "rotate", "disable", "enable", "delete", "manage"}
	if leak := CredentialLeak(meta, req.Secret); leak != "" {
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	core.WriteJSON(w, http.StatusCreated, meta)
}

func getCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, perms []string) {
		meta, err := s.Vault.Get(r.Context(), scope, id)
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		core.WriteJSON(w, http.StatusOK, meta)
	})
}

func updateCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		var req updateCredentialRequest
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if len(req.Secret) > 0 {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Secret material can only be sent to create or rotate.")
			return
		}
		meta, err := s.Vault.Update(r.Context(), scope, id, vault.UpdateInput{
			DisplayName: req.DisplayName,
			Tags:        req.Tags,
			Metadata:    req.Metadata,
			ExpiresAt:   req.ExpiresAt,
		})
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		core.WriteJSON(w, http.StatusOK, meta)
	})
}

func rotateCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		var req rotateCredentialRequest
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		meta, err := s.Vault.Rotate(r.Context(), scope, id, vault.RotateInput{Secret: req.Secret})
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		if leak := CredentialLeak(meta, req.Secret); leak != "" {
			core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
			return
		}
		core.WriteJSON(w, http.StatusOK, meta)
	})
}

func disableCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		meta, err := s.Vault.Disable(r.Context(), scope, id)
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		core.WriteJSON(w, http.StatusOK, meta)
	})
}

func enableCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, perms []string) {
		meta, err := s.Vault.Enable(r.Context(), scope, id)
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		meta.PermittedActions = permittedCredentialActions(perms)
		core.WriteJSON(w, http.StatusOK, meta)
	})
}

func testCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !RequireVault(s, w, r) {
		return
	}
	ws, _, _, perms, ok := s.RequireAccess(w, r, user, "")
	if !ok {
		return
	}
	if !authz.Allows(perms, authz.PermCredentialUse) && !authz.Allows(perms, authz.PermCredentialManage) {
		core.WriteForbidden(w, r)
		return
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, ws.TenantID, ws.WorkbenchKey)
	if err != nil {
		WriteVaultError(w, r, err)
		return
	}
	id := strings.TrimSpace(r.PathValue("credentialId"))
	result, meta, err := s.Vault.Test(r.Context(), scope, id)
	if err != nil && meta.ID == "" {
		WriteVaultError(w, r, err)
		return
	}
	meta.PermittedActions = permittedCredentialActions(perms)
	core.WriteJSON(w, http.StatusOK, map[string]any{"result": result, "credential": meta})
}

func useVaultCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialUse, func(scope isolation.Scope, id string, _ []string) {
		if err := s.Vault.Use(r.Context(), scope, id); err != nil {
			WriteVaultError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func getCredentialUsage(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, _ []string) {
		usage, err := s.Vault.Usage(r.Context(), scope, id)
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusOK, usage)
	})
}

func getCredentialDeletionImpact(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, _ []string) {
		impact, err := s.Vault.DeletionImpact(r.Context(), scope, id)
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusOK, impact)
	})
}

func deleteCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialManage, func(scope isolation.Scope, id string, _ []string) {
		var req deleteCredentialRequest
		if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
			if !core.DecodeJSON(w, r, &req) {
				return
			}
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if err := s.Vault.Delete(r.Context(), scope, id, vault.DeleteInput{Confirm: req.Confirm}); err != nil {
			WriteVaultError(w, r, err)
			return
		}
		if s.Scoped != nil {
			_, _ = s.Scoped.Create(r.Context(), scope, isolation.Record{
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

func listCredentialEvents(s *core.Server, w http.ResponseWriter, r *http.Request) {
	withCredential(s, w, r, authz.PermCredentialView, func(scope isolation.Scope, id string, _ []string) {
		q, ok := core.ParsePage(w, r)
		if !ok {
			return
		}
		items, next, err := s.Vault.EventsPage(r.Context(), scope, id, q)
		if core.RejectPageErr(w, r, err) {
			return
		}
		if err != nil {
			WriteVaultError(w, r, err)
			return
		}
		core.WritePage(w, items, q, next)
	})
}

func withCredential(s *core.Server, w http.ResponseWriter, r *http.Request, perm string, fn func(isolation.Scope, string, []string)) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !RequireVault(s, w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("credentialId"))
	if id == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "credentialId is required.")
		return
	}
	ws, _, _, perms, ok := s.RequireAccess(w, r, user, perm)
	if !ok {
		return
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, ws.TenantID, ws.WorkbenchKey)
	if err != nil {
		WriteVaultError(w, r, err)
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

func CredentialLeak(meta vault.Metadata, secret map[string]string) string {
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

func WriteVaultError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, vault.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, vault.ErrInUse):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Credential is referenced by an active execution.")
	case errors.Is(err, vault.ErrNotConfirmed):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Deletion requires confirm=true after reviewing deletion impact.")
	case errors.Is(err, vault.ErrDisabled):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Credential is disabled.")
	case errors.Is(err, vault.ErrExpired):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Credential is expired.")
	case errors.Is(err, vault.ErrKeyUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Credential encryption key is not configured.")
	case errors.Is(err, vault.ErrDecrypt):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Stored credential payload could not be decrypted.")
	case errors.Is(err, vault.ErrInvalid), errors.Is(err, vault.ErrNoScope):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", err.Error())
	default:
		if err != nil && !errors.Is(err, vault.ErrKeyUnavailable) {
			msg := err.Error()
			if strings.Contains(strings.ToLower(msg), "required") || strings.Contains(msg, "type") || strings.Contains(msg, "tag") || strings.Contains(msg, "metadata") || strings.Contains(msg, "displayName") || strings.Contains(msg, "expiresAt") || strings.Contains(msg, "RFC3339") {
				core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", msg)
				return
			}
		}
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
