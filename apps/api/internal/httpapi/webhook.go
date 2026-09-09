package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
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

func (s *Server) requireHooks(w http.ResponseWriter, r *http.Request) bool {
	if s.hooks != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Webhook triggers are not available.")
	return false
}

func (s *Server) listWorkflowTriggers(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok || !s.requireHooks(w, r) {
		return
	}
	items, err := s.hooks.List(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")))
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[webhook.Trigger]{Items: redactWebhookTriggers(items)})
}

func (s *Server) createWorkflowTrigger(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireHooks(w, r) {
		return
	}
	var req createWebhookRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if typ := strings.TrimSpace(req.Type); typ != "" && typ != webhook.TypeWebhook {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Only webhook triggers are supported.")
		return
	}
	workflowID := strings.TrimSpace(r.PathValue("workflowId"))
	if _, err := s.workflows.Get(r.Context(), scope, workflowID); err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	ver, err := s.workflows.GetVersion(r.Context(), scope, workflowID, strings.TrimSpace(req.WorkflowVersionID))
	if err != nil {
		if errors.Is(err, wfstore.ErrNotFound) || errors.Is(err, wfstore.ErrDraftNotRunnable) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Webhook triggers must pin a published workflow version.")
			return
		}
		writeWorkflowStoreError(w, r, err)
		return
	}
	credID := strings.TrimSpace(req.SecretCredentialID)
	if credID == "" && len(req.Secret) > 0 {
		if !s.requireVault(w, r) {
			return
		}
		meta, createErr := s.vault.Create(r.Context(), scope, vault.CreateInput{
			Type:        vault.TypeWebhookSecret,
			DisplayName: "Webhook " + ver.WorkflowID,
			Secret:      req.Secret,
		})
		if createErr != nil {
			writeVaultError(w, r, createErr)
			return
		}
		if leak := credentialLeak(meta, req.Secret); leak != "" {
			WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
			return
		}
		credID = meta.ID
	}
	if err := s.requireWebhookSecret(w, r, scope, credID); err != nil {
		return
	}
	contentType := strings.TrimSpace(req.ContentType)
	if yamlType := strings.TrimSpace(workflow.ExtractWebhookContentType(ver.DefinitionYAML)); yamlType != "" {
		if contentType == "" {
			contentType = yamlType
		}
	}
	trig, err := s.hooks.Create(r.Context(), scope, webhook.CreateInput{
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
	s.writeTriggerAudit(r, scope, trig, "webhook.trigger.created", "created", nil)
	out := redactWebhookTrigger(trig)
	if leak := webhookResponseLeak(out, req.Secret); leak != "" {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) getTrigger(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok || !s.requireHooks(w, r) {
		return
	}
	trig, err := s.hooks.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")))
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, redactWebhookTrigger(trig))
}

func (s *Server) updateTrigger(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireHooks(w, r) {
		return
	}
	var req updateWebhookRequest
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
	current, err := s.hooks.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")))
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	if req.WorkflowVersionID != nil {
		if _, err := s.workflows.GetVersion(r.Context(), scope, current.WorkflowID, strings.TrimSpace(*req.WorkflowVersionID)); err != nil {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Webhook triggers must pin a published workflow version.")
			return
		}
	}
	if req.SecretCredentialID != nil {
		if err := s.requireWebhookSecret(w, r, scope, strings.TrimSpace(*req.SecretCredentialID)); err != nil {
			return
		}
	}
	trig, err := s.hooks.Update(r.Context(), scope, current.ID, webhook.UpdateInput{
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
	s.writeTriggerAudit(r, scope, trig, "webhook.trigger.updated", "updated", nil)
	writeJSON(w, http.StatusOK, redactWebhookTrigger(trig))
}

func (s *Server) rotateTrigger(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireHooks(w, r) || !s.requireVault(w, r) {
		return
	}
	var req rotateWebhookRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if len(req.Secret) == 0 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Rotate requires a new webhook secret.")
		return
	}
	trig, err := s.hooks.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")))
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	meta, err := s.vault.Rotate(r.Context(), scope, trig.SecretCredentialID, vault.RotateInput{Secret: req.Secret})
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	if leak := credentialLeak(meta, req.Secret); leak != "" {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	s.writeTriggerAudit(r, scope, trig, "webhook.trigger.rotated", "rotated", map[string]any{"secretCredentialId": trig.SecretCredentialID})
	out := redactWebhookTrigger(trig)
	if leak := webhookResponseLeak(out, req.Secret); leak != "" {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) disableTrigger(w http.ResponseWriter, r *http.Request) {
	s.setTriggerStatus(w, r, webhook.StatusDisabled, "webhook.trigger.disabled")
}

func (s *Server) enableTrigger(w http.ResponseWriter, r *http.Request) {
	s.setTriggerStatus(w, r, webhook.StatusEnabled, "webhook.trigger.enabled")
}

func (s *Server) setTriggerStatus(w http.ResponseWriter, r *http.Request, status, action string) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireHooks(w, r) {
		return
	}
	trig, err := s.hooks.SetStatus(r.Context(), scope, strings.TrimSpace(r.PathValue("triggerId")), status)
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	s.writeTriggerAudit(r, scope, trig, action, status, nil)
	writeJSON(w, http.StatusOK, redactWebhookTrigger(trig))
}

func (s *Server) deleteTrigger(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireHooks(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("triggerId"))
	trig, err := s.hooks.Get(r.Context(), scope, id)
	if err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	if err := s.hooks.Delete(r.Context(), scope, trig.ID); err != nil {
		writeWebhookStoreError(w, r, err)
		return
	}
	s.writeTriggerAudit(r, scope, trig, "webhook.trigger.deleted", "deleted", nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) requireWebhookSecret(w http.ResponseWriter, r *http.Request, scope isolation.Scope, credentialID string) error {
	if !s.requireVault(w, r) {
		return webhook.ErrStoreUnavailable
	}
	if strings.TrimSpace(credentialID) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "secretCredentialId is required.")
		return webhook.ErrInvalid
	}
	meta, err := s.vault.Get(r.Context(), scope, credentialID)
	if err != nil {
		writeVaultError(w, r, err)
		return err
	}
	if meta.Type != vault.TypeWebhookSecret {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Webhook secrets must use the webhook_secret credential type.")
		return webhook.ErrSecretType
	}
	if meta.Status != vault.StatusActive {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Webhook secret credential is not active.")
		return webhook.ErrSecretDisabled
	}
	return nil
}

func (s *Server) writeTriggerAudit(r *http.Request, scope isolation.Scope, trig webhook.Trigger, action, outcome string, extra map[string]any) {
	if s.workflows == nil {
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
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        action,
		ResourceType:  "webhook_trigger",
		ResourceID:    trig.ID,
		Outcome:       outcome,
		CorrelationID: RequestIDFromContext(r.Context()),
		HostContext:   map[string]any{"requestId": RequestIDFromContext(r.Context())},
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
