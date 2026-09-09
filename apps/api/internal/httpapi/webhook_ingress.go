package httpapi

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func (s *Server) deliverWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.requireHooks(w, r) {
		return
	}
	publicID := strings.TrimSpace(r.PathValue("publicId"))
	workspaceID, trig, err := s.hooks.LookupPublic(r.Context(), publicID)
	if err != nil {
		writeWebhookIngressError(w, r, err)
		return
	}
	if trig.Status != webhook.StatusEnabled {
		writeWebhookIngressError(w, r, webhook.ErrDisabled)
		return
	}
	scope, err := isolation.Authorize(workspaceID, "")
	if err != nil {
		writeWebhookIngressError(w, r, webhook.ErrNotFound)
		return
	}
	now := s.clockNow()
	limit := int64(trig.MaxBodyBytes)
	if r.ContentLength > limit && r.ContentLength > 0 {
		s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "too-large"})
		WriteProblem(w, r, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "Request Too Large", "The webhook body exceeds the configured size limit.")
		return
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "too-large"})
		WriteProblem(w, r, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "Request Too Large", "The webhook body exceeds the configured size limit.")
		return
	}
	if !webhook.ContentTypeMatches(r.Header.Get("Content-Type"), trig.ContentType) {
		writeWebhookIngressError(w, r, webhook.ErrUnsupportedType)
		return
	}
	timestamp := strings.TrimSpace(r.Header.Get(webhook.TimestampHeader))
	if _, err := webhook.CheckTimestamp(timestamp, now, time.Duration(trig.ClockSkewSeconds)*time.Second); err != nil {
		s.emitWebhookAlert(r, scope, trig, opsalert.KindAuthorization, CodeUnauthenticated, "timestamp-skew")
		s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "timestamp-skew"})
		writeWebhookIngressError(w, r, err)
		return
	}
	plain, err := s.unlockWebhookSecret(r, scope, trig)
	if err != nil {
		s.emitWebhookAlert(r, scope, trig, opsalert.KindAuthorization, CodeUnauthenticated, "secret-unavailable")
		s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "secret-unavailable"})
		writeWebhookIngressError(w, r, webhook.ErrBadSignature)
		return
	}
	if err := webhook.VerifySignature([]byte(plain), timestamp, raw, r.Header.Get(webhook.SignatureHeader)); err != nil {
		s.emitWebhookAlert(r, scope, trig, opsalert.KindAuthorization, CodeUnauthenticated, "bad-signature")
		s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "bad-signature"})
		writeWebhookIngressError(w, r, err)
		return
	}
	_ = s.vault.Use(r.Context(), scope, trig.SecretCredentialID)
	limits := webhook.DeliveryLimits{
		ReplayID:                webhook.ReplayID(timestamp, raw),
		ReplayRetention:         time.Duration(trig.ReplayRetentionSeconds) * time.Second,
		RateLimitPerMinute:      trig.RateLimitPerMinute,
		WorkspaceRatePerMinute:  trig.WorkspaceRatePerMinute,
		MaxConcurrency:          trig.MaxConcurrency,
		WorkspaceMaxConcurrency: trig.WorkspaceMaxConcurrency,
	}
	if err := s.hooks.AcquireDelivery(r.Context(), scope, trig.ID, now, limits); err != nil {
		reason := "replay"
		kind := opsalert.KindReplay
		code := CodeConflict
		if errors.Is(err, webhook.ErrRateLimited) || errors.Is(err, webhook.ErrConcurrency) {
			reason = "rate-limited"
			kind = opsalert.KindAuthorization
			code = CodeRateLimited
		}
		s.emitWebhookAlert(r, scope, trig, kind, code, reason)
		s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": reason})
		writeWebhookIngressError(w, r, err)
		return
	}
	defer s.hooks.ReleaseDelivery(r.Context(), scope, trig.ID, now)

	payload, err := webhook.ParseJSONObject(raw)
	if err != nil {
		writeWebhookIngressError(w, r, err)
		return
	}
	mapped, err := webhook.MapFields(payload, trig.FieldMapping)
	if err != nil {
		writeWebhookIngressError(w, r, err)
		return
	}
	ver, err := s.workflows.GetVersion(r.Context(), scope, trig.WorkflowID, trig.WorkflowVersionID)
	if err != nil {
		writeWebhookIngressError(w, r, webhook.ErrUnpublished)
		return
	}
	if errs := workflow.ValidateWebhookStartInput(mapped, ver.DefinitionYAML); len(errs) > 0 {
		writeManualStartInputErrors(w, r, errs)
		return
	}
	idem := firstNonEmpty(strings.TrimSpace(r.Header.Get("Idempotency-Key")), webhook.DerivedIdempotencyKey(trig.PublicID, timestamp, raw))
	start := wfstore.StartInput{
		VersionID:      ver.ID,
		IdempotencyKey: idem,
		Input:          mapped,
		CorrelationID:  RequestIDFromContext(r.Context()),
		TriggerID:      trig.ID,
		TriggerType:    webhook.TypeWebhook,
		HostContext:    map[string]any{"requestId": RequestIDFromContext(r.Context()), "triggerId": trig.ID},
	}
	s.dispatchWebhookExecution(w, r, scope, trig, ver, start)
}

func (s *Server) unlockWebhookSecret(r *http.Request, scope isolation.Scope, trig webhook.Trigger) (string, error) {
	if s.vault == nil {
		return "", webhook.ErrStoreUnavailable
	}
	meta, err := s.vault.Get(r.Context(), scope, trig.SecretCredentialID)
	if err != nil {
		return "", err
	}
	if meta.Type != vault.TypeWebhookSecret || meta.Status != vault.StatusActive {
		return "", webhook.ErrSecretDisabled
	}
	plain, err := s.vault.Unlock(r.Context(), scope, trig.SecretCredentialID)
	if err != nil {
		return "", err
	}
	return webhook.SecretFromCanonical(plain)
}

func (s *Server) dispatchWebhookExecution(w http.ResponseWriter, r *http.Request, scope isolation.Scope, trig webhook.Trigger, ver wfstore.Version, start wfstore.StartInput) {
	workflowID := trig.WorkflowID
	if start.IdempotencyKey != "" {
		existing, peekErr := s.workflows.PeekIdempotent(r.Context(), scope, workflowID, start)
		if peekErr == nil {
			s.writeWebhookIngressAudit(r, scope, trig, "replayed", map[string]any{"executionId": existing.ID})
			s.writeExecutionDetail(w, r, scope, existing, http.StatusOK)
			return
		}
		if !errors.Is(peekErr, wfstore.ErrNotFound) {
			s.emitSecurityError(r, scope, peekErr)
			s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "idempotency-fingerprint-mismatch"})
			writeWorkflowStoreError(w, r, peekErr)
			return
		}
	}
	if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 && s.ops != nil {
		if _, err := s.ops.Resolve(r.Context(), scope, refs); err != nil {
			writeOpsError(w, r, err)
			return
		}
	}
	if !s.verifyWorkflowScriptPins(w, r, scope, ver.DefinitionYAML, ver.ID) {
		return
	}
	if s.approvals != nil {
		eval, evalErr := s.evaluateVersion(r.Context(), scope, workflowID, ver.ID)
		if evalErr != nil {
			writeApprovalEvalError(w, r, evalErr)
			return
		}
		if eval.Decision == policy.DecisionDeny {
			s.emitAlert(r, scope, opsalert.Signal{
				Kind:         opsalert.KindPolicy,
				Action:       "webhook.deliver",
				ResourceType: "webhook_trigger",
				ResourceID:   trig.ID,
				Code:         CodeForbidden,
				Details:      map[string]any{"reason": "policy-deny"},
			})
			s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "policy-deny"})
			WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", denyDetail(eval))
			return
		}
		if _, gateErr := s.dispatchApprovalsOK(r.Context(), scope, eval, workflowID, ver.ID); gateErr != nil {
			if errors.Is(gateErr, errPolicyDenied) {
				s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "policy-deny"})
				WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", denyDetail(eval))
				return
			}
			if errors.Is(gateErr, errApprovalRequired) {
				s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "approval-required"})
				WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Dispatch requires a valid approval bound to the current workflow version, target, policy revision, and operation.")
				return
			}
			writeApprovalError(w, r, gateErr)
			return
		}
	}
	exec, err := s.workflows.StartExecution(r.Context(), scope, workflowID, start)
	if err != nil {
		s.emitSecurityError(r, scope, err)
		s.writeWebhookIngressAudit(r, scope, trig, "denied", map[string]any{"reason": "start-failed"})
		writeWorkflowStoreError(w, r, err)
		return
	}
	if exec.Replayed {
		s.writeWebhookIngressAudit(r, scope, trig, "replayed", map[string]any{"executionId": exec.ID})
		s.writeExecutionDetail(w, r, scope, exec, http.StatusOK)
		return
	}
	if s.ops != nil {
		copied, copyErr := s.ops.CopyPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID)
		if copyErr != nil {
			writeOpsError(w, r, copyErr)
			return
		}
		if len(copied) == 0 {
			if _, ok := s.pinWorkflowRefs(w, r, scope, ver.DefinitionYAML, opsconfig.OwnerExecution, exec.ID); !ok {
				return
			}
		}
	}
	s.writeWebhookIngressAudit(r, scope, trig, "created", map[string]any{"executionId": exec.ID})
	s.writeExecutionDetail(w, r, scope, exec, http.StatusCreated)
}

func (s *Server) writeWebhookIngressAudit(r *http.Request, scope isolation.Scope, trig webhook.Trigger, outcome string, extra map[string]any) {
	if s.workflows == nil {
		return
	}
	details := map[string]any{
		"triggerId":         trig.ID,
		"workflowId":        trig.WorkflowID,
		"workflowVersionId": trig.WorkflowVersionID,
		"triggerType":       webhook.TypeWebhook,
		"correlationId":     RequestIDFromContext(r.Context()),
		"outcome":           outcome,
	}
	for k, v := range extra {
		details[k] = v
	}
	resourceType := "webhook_trigger"
	resourceID := trig.ID
	if execID, ok := extra["executionId"].(string); ok && execID != "" {
		resourceType = "execution"
		resourceID = execID
	}
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        "execution.start",
		ResourceType:  resourceType,
		ResourceID:    resourceID,
		Outcome:       outcome,
		CorrelationID: RequestIDFromContext(r.Context()),
		HostContext:   map[string]any{"requestId": RequestIDFromContext(r.Context())},
		Details:       details,
	})
}

func (s *Server) emitWebhookAlert(r *http.Request, scope isolation.Scope, trig webhook.Trigger, kind, code, reason string) {
	s.emitAlert(r, scope, opsalert.Signal{
		Kind:         kind,
		Action:       "webhook.deliver",
		ResourceType: "webhook_trigger",
		ResourceID:   trig.ID,
		Code:         code,
		Details:      map[string]any{"reason": reason},
	})
}

func writeWebhookIngressError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, webhook.ErrNotFound), errors.Is(err, webhook.ErrDisabled), errors.Is(err, webhook.ErrUnpublished):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, webhook.ErrBadSignature), errors.Is(err, webhook.ErrTimestampSkew), errors.Is(err, webhook.ErrSecretDisabled), errors.Is(err, webhook.ErrSecretType):
		WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", "Webhook signature verification failed.")
	case errors.Is(err, webhook.ErrReplay):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Webhook delivery was replayed.")
	case errors.Is(err, webhook.ErrRateLimited), errors.Is(err, webhook.ErrConcurrency):
		WriteProblem(w, r, http.StatusTooManyRequests, CodeRateLimited, "Rate Limited", "Webhook rate or concurrency limit was exceeded.")
	case errors.Is(err, webhook.ErrTooLarge):
		WriteProblem(w, r, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "Request Too Large", "The webhook body exceeds the configured size limit.")
	case errors.Is(err, webhook.ErrUnsupportedType):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Unsupported webhook content type.")
	case errors.Is(err, webhook.ErrInvalid):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Webhook payload is not a JSON object.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}

func writeWebhookStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, webhook.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, webhook.ErrUnpublished):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Webhook triggers must pin a published workflow version.")
	case errors.Is(err, webhook.ErrInvalid), errors.Is(err, webhook.ErrSecretType), errors.Is(err, webhook.ErrSecretDisabled):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Webhook trigger configuration is invalid.")
	case errors.Is(err, webhook.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "A webhook trigger with this identity already exists.")
	case errors.Is(err, webhook.ErrNoScope):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Workspace scope is required.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
