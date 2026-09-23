package webhookhttp

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/vaulthttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/workflowhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type createWebhookRequest struct {
	ID                      string            `json:"id"`
	WorkspaceID             string            `json:"workspace_id"`
	WorkspaceIDAlt          string            `json:"workspaceId"`
	Type                    string            `json:"type"`
	WorkflowVersionID       string            `json:"workflowVersionId"`
	SecretCredentialID      string            `json:"secretCredentialId"`
	ContentType             string            `json:"contentType"`
	FieldMapping            map[string]string `json:"fieldMapping"`
	MaxBodyBytes            int               `json:"maxBodyBytes"`
	ClockSkewSeconds        int               `json:"clockSkewSeconds"`
	ReplayRetentionSeconds  int               `json:"replayRetentionSeconds"`
	RateLimitPerMinute      int               `json:"rateLimitPerMinute"`
	WorkspaceRatePerMinute  int               `json:"workspaceRatePerMinute"`
	MaxConcurrency          int               `json:"maxConcurrency"`
	WorkspaceMaxConcurrency int               `json:"workspaceMaxConcurrency"`
	Secret                  map[string]string `json:"secret"`
}

type updateWebhookRequest struct {
	ID                      string             `json:"id"`
	WorkspaceID             string             `json:"workspace_id"`
	WorkspaceIDAlt          string             `json:"workspaceId"`
	WorkflowVersionID       *string            `json:"workflowVersionId"`
	SecretCredentialID      *string            `json:"secretCredentialId"`
	ContentType             *string            `json:"contentType"`
	FieldMapping            *map[string]string `json:"fieldMapping"`
	MaxBodyBytes            *int               `json:"maxBodyBytes"`
	ClockSkewSeconds        *int               `json:"clockSkewSeconds"`
	ReplayRetentionSeconds  *int               `json:"replayRetentionSeconds"`
	RateLimitPerMinute      *int               `json:"rateLimitPerMinute"`
	WorkspaceRatePerMinute  *int               `json:"workspaceRatePerMinute"`
	MaxConcurrency          *int               `json:"maxConcurrency"`
	WorkspaceMaxConcurrency *int               `json:"workspaceMaxConcurrency"`
	Secret                  map[string]string  `json:"secret"`
}

type rotateWebhookRequest struct {
	ID             string            `json:"id"`
	WorkspaceID    string            `json:"workspace_id"`
	WorkspaceIDAlt string            `json:"workspaceId"`
	Secret         map[string]string `json:"secret"`
}

func requireHooks(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.Hooks != nil {
		return true
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Webhook triggers are not available.")
	return false
}

func listWorkflowTriggers(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if workflowhttp.RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := workflowhttp.WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok || !requireHooks(s, w, r) {
		return
	}
	q, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	items, next, err := s.Hooks.ListPage(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), q)
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	core.WritePage(w, redactWebhookTriggers(items), q, next)
}

func createWorkflowTrigger(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if workflowhttp.RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := workflowhttp.WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireHooks(s, w, r) {
		return
	}
	var req createWebhookRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if typ := strings.TrimSpace(req.Type); typ != "" && typ != webhook.TypeWebhook {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Only webhook triggers are supported.")
		return
	}
	workflowID := strings.TrimSpace(r.PathValue("workflowId"))
	if _, err := s.Workflows.Get(r.Context(), scope, workflowID); err != nil {
		workflowhttp.WriteWorkflowStoreError(w, r, err)
		return
	}
	ver, err := s.Workflows.GetVersion(r.Context(), scope, workflowID, strings.TrimSpace(req.WorkflowVersionID))
	if err != nil {
		if errors.Is(err, wfstore.ErrNotFound) || errors.Is(err, wfstore.ErrDraftNotRunnable) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Webhook triggers must pin a published workflow version.")
			return
		}
		workflowhttp.WriteWorkflowStoreError(w, r, err)
		return
	}
	credID := strings.TrimSpace(req.SecretCredentialID)
	if credID == "" && len(req.Secret) > 0 {
		if !vaulthttp.RequireVault(s, w, r) {
			return
		}
		meta, createErr := s.Vault.Create(r.Context(), scope, vault.CreateInput{
			Type:        vault.TypeWebhookSecret,
			DisplayName: "Webhook " + ver.WorkflowID,
			Secret:      req.Secret,
		})
		if createErr != nil {
			vaulthttp.WriteVaultError(w, r, createErr)
			return
		}
		if leak := vaulthttp.CredentialLeak(meta, req.Secret); leak != "" {
			core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
			return
		}
		credID = meta.ID
	}
	if err := requireWebhookSecret(s, w, r, scope, credID); err != nil {
		return
	}
	contentType := strings.TrimSpace(req.ContentType)
	if yamlType := strings.TrimSpace(workflow.ExtractWebhookContentType(ver.DefinitionYAML)); yamlType != "" {
		if contentType == "" {
			contentType = yamlType
		}
	}
	trig, err := s.Hooks.Create(r.Context(), scope, webhook.CreateInput{
		WorkflowID:              workflowID,
		WorkflowVersionID:       ver.ID,
		SecretCredentialID:      credID,
		ContentType:             contentType,
		FieldMapping:            req.FieldMapping,
		MaxBodyBytes:            req.MaxBodyBytes,
		ClockSkewSeconds:        req.ClockSkewSeconds,
		ReplayRetentionSeconds:  req.ReplayRetentionSeconds,
		RateLimitPerMinute:      req.RateLimitPerMinute,
		WorkspaceRatePerMinute:  req.WorkspaceRatePerMinute,
		MaxConcurrency:          req.MaxConcurrency,
		WorkspaceMaxConcurrency: req.WorkspaceMaxConcurrency,
	})
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	writeTriggerAudit(s, r, scope, trig, "webhook.trigger.created", "created", nil)
	out := redactWebhookTrigger(trig)
	if leak := webhookResponseLeak(out, req.Secret); leak != "" {
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	core.WriteJSON(w, http.StatusCreated, out)
}

func getTrigger(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := workflowhttp.WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok || !requireHooks(s, w, r) {
		return
	}
	trig, err := s.Hooks.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")))
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, redactWebhookTrigger(trig))
}

func updateTrigger(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := workflowhttp.WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireHooks(s, w, r) {
		return
	}
	var req updateWebhookRequest
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
	current, err := s.Hooks.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")))
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	if req.WorkflowVersionID != nil {
		if _, err := s.Workflows.GetVersion(r.Context(), scope, current.WorkflowID, strings.TrimSpace(*req.WorkflowVersionID)); err != nil {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Webhook triggers must pin a published workflow version.")
			return
		}
	}
	if req.SecretCredentialID != nil {
		if err := requireWebhookSecret(s, w, r, scope, strings.TrimSpace(*req.SecretCredentialID)); err != nil {
			return
		}
	}
	trig, err := s.Hooks.Update(r.Context(), scope, current.ID, webhook.UpdateInput{
		WorkflowVersionID:       req.WorkflowVersionID,
		SecretCredentialID:      req.SecretCredentialID,
		ContentType:             req.ContentType,
		FieldMapping:            req.FieldMapping,
		MaxBodyBytes:            req.MaxBodyBytes,
		ClockSkewSeconds:        req.ClockSkewSeconds,
		ReplayRetentionSeconds:  req.ReplayRetentionSeconds,
		RateLimitPerMinute:      req.RateLimitPerMinute,
		WorkspaceRatePerMinute:  req.WorkspaceRatePerMinute,
		MaxConcurrency:          req.MaxConcurrency,
		WorkspaceMaxConcurrency: req.WorkspaceMaxConcurrency,
	})
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	writeTriggerAudit(s, r, scope, trig, "webhook.trigger.updated", "updated", nil)
	core.WriteJSON(w, http.StatusOK, redactWebhookTrigger(trig))
}

func rotateTrigger(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := workflowhttp.WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireHooks(s, w, r) || !vaulthttp.RequireVault(s, w, r) {
		return
	}
	var req rotateWebhookRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if len(req.Secret) == 0 {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Rotate requires a new webhook secret.")
		return
	}
	trig, err := s.Hooks.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")))
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	meta, err := s.Vault.Rotate(r.Context(), scope, trig.SecretCredentialID, vault.RotateInput{Secret: req.Secret})
	if err != nil {
		vaulthttp.WriteVaultError(w, r, err)
		return
	}
	if leak := vaulthttp.CredentialLeak(meta, req.Secret); leak != "" {
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	writeTriggerAudit(s, r, scope, trig, "webhook.trigger.rotated", "rotated", map[string]any{"secretCredentialId": trig.SecretCredentialID})
	out := redactWebhookTrigger(trig)
	if leak := webhookResponseLeak(out, req.Secret); leak != "" {
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

func disableTrigger(s *core.Server, w http.ResponseWriter, r *http.Request) {
	setTriggerStatus(s, w, r, webhook.StatusDisabled, "webhook.trigger.disabled")
}

func enableTrigger(s *core.Server, w http.ResponseWriter, r *http.Request) {
	setTriggerStatus(s, w, r, webhook.StatusEnabled, "webhook.trigger.enabled")
}

func setTriggerStatus(s *core.Server, w http.ResponseWriter, r *http.Request, status, action string) {
	scope, ok := workflowhttp.WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireHooks(s, w, r) {
		return
	}
	trig, err := s.Hooks.SetStatus(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")), status)
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	writeTriggerAudit(s, r, scope, trig, action, status, nil)
	core.WriteJSON(w, http.StatusOK, redactWebhookTrigger(trig))
}

func deleteTrigger(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := workflowhttp.WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireHooks(s, w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("triggerId"))
	trig, err := s.Hooks.Get(r.Context(), scope, id)
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	if err := s.Hooks.Delete(r.Context(), scope, trig.ID); err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	writeTriggerAudit(s, r, scope, trig, "webhook.trigger.deleted", "deleted", nil)
	w.WriteHeader(http.StatusNoContent)
}

func requireWebhookSecret(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, credentialID string) error {
	if !vaulthttp.RequireVault(s, w, r) {
		return webhook.ErrStoreUnavailable
	}
	if strings.TrimSpace(credentialID) == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "secretCredentialId is required.")
		return webhook.ErrInvalid
	}
	meta, err := s.Vault.Get(r.Context(), scope, credentialID)
	if err != nil {
		vaulthttp.WriteVaultError(w, r, err)
		return err
	}
	if meta.Type != vault.TypeWebhookSecret {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Webhook secrets must use the webhook_secret credential type.")
		return webhook.ErrSecretType
	}
	if meta.Status != vault.StatusActive {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Webhook secret credential is not active.")
		return webhook.ErrSecretDisabled
	}
	return nil
}

func writeTriggerAudit(s *core.Server, r *http.Request, scope isolation.Scope, trig webhook.Trigger, action, outcome string, extra map[string]any) {
	if s.Workflows == nil {
		return
	}
	details := map[string]any{
		"triggerId":          trig.ID,
		"publicId":           trig.PublicID,
		"workflowId":         trig.WorkflowID,
		"workflowVersionId":  trig.WorkflowVersionID,
		"secretCredentialId": trig.SecretCredentialID,
		"outcome":            outcome,
	}
	for k, v := range extra {
		details[k] = v
	}
	_, _ = s.Workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        action,
		ResourceType:  "webhook_trigger",
		ResourceID:    trig.ID,
		Outcome:       outcome,
		CorrelationID: core.RequestIDFromContext(r.Context()),
		HostContext:   map[string]any{"requestId": core.RequestIDFromContext(r.Context())},
		Details:       details,
	})
}

func redactWebhookTriggers(items []webhook.Trigger) []webhook.Trigger {
	out := make([]webhook.Trigger, 0, len(items))
	for _, item := range items {
		out = append(out, redactWebhookTrigger(item))
	}
	return out
}

func redactWebhookTrigger(trig webhook.Trigger) webhook.Trigger {
	out := trig
	out.IngressPath = webhook.IngressPathFor(trig.PublicID)
	if out.FieldMapping == nil {
		out.FieldMapping = map[string]string{}
	}
	return out
}

func webhookResponseLeak(trig webhook.Trigger, secret map[string]string) string {
	raw, _ := json.Marshal(trig)
	for _, v := range secret {
		if v != "" && strings.Contains(string(raw), v) {
			return v
		}
	}
	return ""
}
