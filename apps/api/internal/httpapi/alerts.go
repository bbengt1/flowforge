package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func (s *Server) requireAlerts(w http.ResponseWriter, r *http.Request) bool {
	if s.alerts == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Alert store is not available.")
		return false
	}
	return true
}

func (s *Server) listOperationalAlerts(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.alertScope(w, r, authz.PermAlertView)
	if !ok {
		return
	}
	items, err := s.alerts.List(r.Context(), scope, opsalert.ListFilter{
		Kind:         strings.TrimSpace(r.URL.Query().Get("kind")),
		Status:       strings.TrimSpace(r.URL.Query().Get("status")),
		ResourceType: strings.TrimSpace(r.URL.Query().Get("resourceType")),
		ResourceID:   strings.TrimSpace(r.URL.Query().Get("resourceId")),
		Limit:        queryLimit(r),
	})
	if err != nil {
		writeAlertError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[opsalert.Alert]{Items: items})
}

func (s *Server) getOperationalAlert(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.alertScope(w, r, authz.PermAlertView)
	if !ok {
		return
	}
	alert, err := s.alerts.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("alertId")))
	if err != nil {
		writeAlertError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, alert)
}

func (s *Server) ackOperationalAlert(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.alertScope(w, r, authz.PermAlertAck)
	if !ok {
		return
	}
	if r.ContentLength > 0 {
		var req struct {
			ID             string `json:"id"`
			WorkspaceID    string `json:"workspace_id"`
			WorkspaceIDAlt string `json:"workspaceId"`
		}
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	alert, err := s.alerts.Ack(r.Context(), scope, strings.TrimSpace(r.PathValue("alertId")))
	if err != nil {
		writeAlertError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, alert)
}

func (s *Server) alertScope(w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !s.requireAlerts(w, r) {
		return isolation.Scope{}, false
	}
	return s.requireScope(w, r, user, perm)
}

func (s *Server) emitAlert(r *http.Request, scope isolation.Scope, in opsalert.Signal) {
	if s.alerts == nil || scope.Zero() {
		return
	}
	if in.RequestID == "" {
		in.RequestID = RequestIDFromContext(r.Context())
	}
	if in.CorrelationID == "" {
		in.CorrelationID = in.RequestID
	}
	if in.ActorID == "" {
		in.ActorID = scope.ActorID()
	}
	if in.Outcome == "" {
		in.Outcome = "denied"
	}
	alert, err := s.alerts.Emit(r.Context(), scope, in)
	if err != nil {
		if s.log != nil {
			s.log.Warn("operational alert emit failed", "kind", in.Kind, "request_id", in.RequestID)
		}
		return
	}
	if s.workflows == nil {
		return
	}
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        "alert." + alert.Kind,
		ResourceType:  firstNonEmpty(alert.ResourceType, "alert"),
		ResourceID:    alert.ResourceID,
		Outcome:       alert.Outcome,
		CorrelationID: alert.CorrelationID,
		Details: map[string]any{
			"kind":    alert.Kind,
			"code":    alert.Code,
			"alertId": alert.ID,
		},
	})
}

func (s *Server) emitAuthorizationDenied(r *http.Request, user identity.User, ws identity.Workspace, action string) {
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, ws.TenantID, ws.WorkbenchKey)
	if err != nil {
		return
	}
	s.emitAlert(r, scope, opsalert.Signal{
		Kind:         opsalert.KindAuthorization,
		Action:       action,
		ResourceType: "workspace",
		ResourceID:   ws.ID,
		Code:         CodeForbidden,
		Outcome:      "denied",
		Details:      map[string]any{"reason": "missing-permission"},
	})
}

func (s *Server) emitSecurityError(r *http.Request, scope isolation.Scope, err error) {
	switch {
	case errors.Is(err, wfstore.ErrIdempotencyConflict):
		s.emitAlert(r, scope, opsalert.Signal{
			Kind:         opsalert.KindReplay,
			Action:       "workflow.execute",
			ResourceType: "execution",
			Code:         CodeConflict,
			Details:      map[string]any{"reason": "idempotency-fingerprint-mismatch"},
		})
	case errors.Is(err, wfstore.ErrJobBinding):
		s.emitAlert(r, scope, opsalert.Signal{
			Kind:         opsalert.KindAuthorization,
			Action:       "workflow.execute",
			ResourceType: "job",
			Code:         CodeForbidden,
			Details:      map[string]any{"reason": "job-binding-rejected"},
		})
	case errors.Is(err, wfstore.ErrUnsafeArtifact):
		s.emitAlert(r, scope, opsalert.Signal{
			Kind:         opsalert.KindRedaction,
			Action:       "artifact.upload",
			ResourceType: "execution",
			Code:         CodeInvalidRequest,
			Details:      map[string]any{"reason": "unsafe-content"},
		})
	}
}

func writeAlertError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, opsalert.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, opsalert.ErrInvalid), errors.Is(err, opsalert.ErrNoScope):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, opsalert.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Alert store is not available.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
