package webhookhttp

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/workflowhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func deliverWebhook(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !requireHooks(s, w, r) {
		return
	}
	publicID := strings.TrimSpace(r.PathValue("publicId"))
	workspaceID, trig, err := s.Hooks.LookupPublic(r.Context(), publicID)
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
	// Tombstoned parents stay 404 before the body is read and before any
	// signature check, even if the trigger row was forced back to enabled.
	if err := workflowhttp.LiveWorkflow(r.Context(), s.Workflows, scope, trig.WorkflowID); err != nil {
		if errors.Is(err, wfstore.ErrNotFound) {
			writeWebhookIngressError(w, r, webhook.ErrNotFound)
			return
		}
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
		return
	}
	now := s.ClockNow()
	limit := int64(trig.MaxBodyBytes)
	if r.ContentLength > limit && r.ContentLength > 0 {
		writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "too-large"})
		core.WriteProblem(w, r, http.StatusRequestEntityTooLarge, core.CodeRequestTooLarge, "Request Too Large", "The webhook body exceeds the configured size limit.")
		return
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "too-large"})
		core.WriteProblem(w, r, http.StatusRequestEntityTooLarge, core.CodeRequestTooLarge, "Request Too Large", "The webhook body exceeds the configured size limit.")
		return
	}
	if !webhook.ContentTypeMatches(r.Header.Get("Content-Type"), trig.ContentType) {
		writeWebhookIngressError(w, r, webhook.ErrUnsupportedType)
		return
	}
	timestamp := strings.TrimSpace(r.Header.Get(webhook.TimestampHeader))
	if _, err := webhook.CheckTimestamp(timestamp, now, time.Duration(trig.ClockSkewSeconds)*time.Second); err != nil {
		emitWebhookAlert(s, r, scope, trig, opsalert.KindAuthorization, core.CodeUnauthenticated, "timestamp-skew")
		writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "timestamp-skew"})
		writeWebhookIngressError(w, r, err)
		return
	}
	plain, err := unlockWebhookSecret(s, r, scope, trig)
	if err != nil {
		emitWebhookAlert(s, r, scope, trig, opsalert.KindAuthorization, core.CodeUnauthenticated, "secret-unavailable")
		writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "secret-unavailable"})
		writeWebhookIngressError(w, r, webhook.ErrBadSignature)
		return
	}
	if err := webhook.VerifySignature([]byte(plain), timestamp, raw, r.Header.Get(webhook.SignatureHeader)); err != nil {
		emitWebhookAlert(s, r, scope, trig, opsalert.KindAuthorization, core.CodeUnauthenticated, "bad-signature")
		writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "bad-signature"})
		writeWebhookIngressError(w, r, err)
		return
	}
	_ = s.Vault.Use(r.Context(), scope, trig.SecretCredentialID)
	limits := webhook.DeliveryLimits{
		ReplayID:                webhook.ReplayID(timestamp, raw),
		ReplayRetention:         time.Duration(trig.ReplayRetentionSeconds) * time.Second,
		RateLimitPerMinute:      trig.RateLimitPerMinute,
		WorkspaceRatePerMinute:  trig.WorkspaceRatePerMinute,
		MaxConcurrency:          trig.MaxConcurrency,
		WorkspaceMaxConcurrency: trig.WorkspaceMaxConcurrency,
	}
	if err := s.Hooks.AcquireDelivery(r.Context(), scope, trig.ID, now, limits); err != nil {
		reason := "replay"
		kind := opsalert.KindReplay
		code := core.CodeConflict
		if errors.Is(err, webhook.ErrRateLimited) || errors.Is(err, webhook.ErrConcurrency) {
			reason = "rate-limited"
			kind = opsalert.KindAuthorization
			code = core.CodeRateLimited
		}
		emitWebhookAlert(s, r, scope, trig, kind, code, reason)
		writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": reason})
		writeWebhookIngressError(w, r, err)
		return
	}
	defer s.Hooks.ReleaseDelivery(r.Context(), scope, trig.ID, now)

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
	ver, err := s.Workflows.GetVersion(r.Context(), scope, trig.WorkflowID, trig.WorkflowVersionID)
	if err != nil {
		writeWebhookIngressError(w, r, webhook.ErrUnpublished)
		return
	}
	if errs := workflow.ValidateWebhookStartInput(mapped, ver.DefinitionYAML); len(errs) > 0 {
		workflowhttp.WriteManualStartInputErrors(w, r, errs)
		return
	}
	idem := core.FirstNonEmpty(strings.TrimSpace(r.Header.Get("Idempotency-Key")), webhook.DerivedIdempotencyKey(trig.PublicID, timestamp, raw))
	start := wfstore.StartInput{
		VersionID:      ver.ID,
		IdempotencyKey: idem,
		Input:          mapped,
		CorrelationID:  core.RequestIDFromContext(r.Context()),
		TriggerID:      trig.ID,
		TriggerType:    webhook.TypeWebhook,
		HostContext:    map[string]any{"requestId": core.RequestIDFromContext(r.Context()), "triggerId": trig.ID},
	}
	dispatchWebhookExecution(s, w, r, scope, trig, ver, start)
}

func unlockWebhookSecret(s *core.Server, r *http.Request, scope isolation.Scope, trig webhook.Trigger) (string, error) {
	if s.Vault == nil {
		return "", webhook.ErrStoreUnavailable
	}
	meta, err := s.Vault.Get(r.Context(), scope, trig.SecretCredentialID)
	if err != nil {
		return "", err
	}
	if meta.Type != vault.TypeWebhookSecret || meta.Status != vault.StatusActive {
		return "", webhook.ErrSecretDisabled
	}
	plain, err := s.Vault.Unlock(r.Context(), scope, trig.SecretCredentialID)
	if err != nil {
		return "", err
	}
	return webhook.SecretFromCanonical(plain)
}

func dispatchWebhookExecution(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, trig webhook.Trigger, ver wfstore.Version, start wfstore.StartInput) {
	workflowID := trig.WorkflowID
	if start.IdempotencyKey != "" {
		existing, peekErr := s.Workflows.PeekIdempotent(r.Context(), scope, workflowID, start)
		if peekErr == nil {
			writeWebhookIngressAudit(s, r, scope, trig, "replayed", map[string]any{"executionId": existing.ID})
			workflowhttp.WriteExecutionDetail(s, w, r, scope, existing, http.StatusOK)
			return
		}
		if !errors.Is(peekErr, wfstore.ErrNotFound) {
			s.EmitSecurityError(r, scope, peekErr)
			writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "idempotency-fingerprint-mismatch"})
			workflowhttp.WriteWorkflowStoreError(w, r, peekErr)
			return
		}
	}
	if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 && s.Ops != nil {
		if _, err := s.Ops.Resolve(r.Context(), scope, refs); err != nil {
			workflowhttp.WriteOpsError(w, r, err)
			return
		}
	}
	if !workflowhttp.VerifyWorkflowScriptPins(s, w, r, scope, ver.DefinitionYAML, ver.ID) {
		return
	}
	if s.Approvals != nil {
		eval, evalErr := approvalhttp.EvaluateVersion(s, r.Context(), scope, workflowID, ver.ID)
		if evalErr != nil {
			approvalhttp.WriteApprovalEvalError(w, r, evalErr)
			return
		}
		if eval.Decision == policy.DecisionDeny {
			s.EmitAlert(r, scope, opsalert.Signal{
				Kind:         opsalert.KindPolicy,
				Action:       "webhook.deliver",
				ResourceType: "webhook_trigger",
				ResourceID:   trig.ID,
				Code:         core.CodeForbidden,
				Details:      map[string]any{"reason": "policy-deny"},
			})
			writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "policy-deny"})
			core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", approvalhttp.DenyDetail(eval))
			return
		}
		if _, gateErr := approvalhttp.DispatchApprovalsOK(s, r.Context(), scope, eval, workflowID, ver.ID); gateErr != nil {
			if errors.Is(gateErr, approvalhttp.ErrPolicyDenied) {
				writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "policy-deny"})
				core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", approvalhttp.DenyDetail(eval))
				return
			}
			if errors.Is(gateErr, approvalhttp.ErrApprovalRequired) {
				writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "approval-required"})
				core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Dispatch requires a valid approval bound to the current workflow version, target, policy revision, and operation.")
				return
			}
			approvalhttp.WriteApprovalError(w, r, gateErr)
			return
		}
	}
	exec, err := s.Workflows.StartExecution(r.Context(), scope, workflowID, s.CapStart(start))
	if err != nil {
		s.EmitSecurityError(r, scope, err)
		writeWebhookIngressAudit(s, r, scope, trig, "denied", map[string]any{"reason": "start-failed"})
		workflowhttp.WriteWorkflowStoreError(w, r, err)
		return
	}
	if exec.Replayed {
		writeWebhookIngressAudit(s, r, scope, trig, "replayed", map[string]any{"executionId": exec.ID})
		workflowhttp.WriteExecutionDetail(s, w, r, scope, exec, http.StatusOK)
		return
	}
	var pins []opsconfig.Pin
	if s.Ops != nil {
		copied, copyErr := s.Ops.CopyPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID)
		if copyErr != nil {
			workflowhttp.WriteOpsError(w, r, copyErr)
			return
		}
		pins = copied
		if len(copied) == 0 {
			pinned, ok := workflowhttp.PinWorkflowRefs(s, w, r, scope, ver.DefinitionYAML, opsconfig.OwnerExecution, exec.ID)
			if !ok {
				return
			}
			pins = pinned
		}
	}
	approval.RememberRun(s.Approvals, exec.ID, exec.WorkflowVersionID, exec.WorkflowDigest, pins)
	writeWebhookIngressAudit(s, r, scope, trig, "created", map[string]any{"executionId": exec.ID})
	workflowhttp.WriteExecutionDetail(s, w, r, scope, exec, http.StatusCreated)
}

func writeWebhookIngressAudit(s *core.Server, r *http.Request, scope isolation.Scope, trig webhook.Trigger, outcome string, extra map[string]any) {
	if s.Workflows == nil {
		return
	}
	details := map[string]any{
		"triggerId":         trig.ID,
		"workflowId":        trig.WorkflowID,
		"workflowVersionId": trig.WorkflowVersionID,
		"triggerType":       webhook.TypeWebhook,
		"correlationId":     core.RequestIDFromContext(r.Context()),
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
	_, _ = s.Workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        "execution.start",
		ResourceType:  resourceType,
		ResourceID:    resourceID,
		Outcome:       outcome,
		CorrelationID: core.RequestIDFromContext(r.Context()),
		HostContext:   map[string]any{"requestId": core.RequestIDFromContext(r.Context())},
		Details:       details,
	})
}

func emitWebhookAlert(s *core.Server, r *http.Request, scope isolation.Scope, trig webhook.Trigger, kind, code, reason string) {
	s.EmitAlert(r, scope, opsalert.Signal{
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
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, webhook.ErrBadSignature), errors.Is(err, webhook.ErrTimestampSkew), errors.Is(err, webhook.ErrSecretDisabled), errors.Is(err, webhook.ErrSecretType):
		core.WriteProblem(w, r, http.StatusUnauthorized, core.CodeUnauthenticated, "Unauthenticated", "Webhook signature verification failed.")
	case errors.Is(err, webhook.ErrReplay):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Webhook delivery was replayed.")
	case errors.Is(err, webhook.ErrRateLimited), errors.Is(err, webhook.ErrConcurrency):
		core.WriteProblem(w, r, http.StatusTooManyRequests, core.CodeRateLimited, "Rate Limited", "Webhook rate or concurrency limit was exceeded.")
	case errors.Is(err, webhook.ErrTooLarge):
		core.WriteProblem(w, r, http.StatusRequestEntityTooLarge, core.CodeRequestTooLarge, "Request Too Large", "The webhook body exceeds the configured size limit.")
	case errors.Is(err, webhook.ErrUnsupportedType):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Unsupported webhook content type.")
	case errors.Is(err, webhook.ErrInvalid):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Webhook payload is not a JSON object.")
	default:
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}

func writeWebhookStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, webhook.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, webhook.ErrUnpublished):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Webhook triggers must pin a published workflow version.")
	case errors.Is(err, webhook.ErrInvalid), errors.Is(err, webhook.ErrSecretType), errors.Is(err, webhook.ErrSecretDisabled):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Webhook trigger configuration is invalid.")
	case errors.Is(err, webhook.ErrConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "A webhook trigger with this identity already exists.")
	case errors.Is(err, webhook.ErrNoScope):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Workspace scope is required.")
	default:
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
