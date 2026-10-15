package workflowhttp

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/itemcursor"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// #650 E3.1: paged, redacted step items.

const (
	// CodeCursorInvalid is a cursor that fails signature, kid, expiry, or
	// binding checks. The detail never says which.
	CodeCursorInvalid = "cursor-invalid"
	// ItemsPrincipalPerMinute and ItemsWorkspacePerMinute bound the items
	// read on top of the workspace read quota.
	ItemsPrincipalPerMinute = 120
	ItemsWorkspacePerMinute = 600
)

type stepItemsResponse struct {
	Items      []wfstore.StepItem `json:"items"`
	Total      int                `json:"total"`
	NextCursor string             `json:"nextCursor,omitempty"`
}

func listStepItems(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	store, ok := s.Workflows.(wfstore.ItemStore)
	if !ok || s.ItemsCursor == nil || s.ItemsLimiter == nil {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Step items are not available.")
		return
	}
	now := s.ClockNow()
	for _, lim := range []struct {
		key   string
		limit int
	}{
		{"items-principal:" + scope.ActorID(), ItemsPrincipalPerMinute},
		{"items-workspace:" + scope.WorkspaceID(), ItemsWorkspacePerMinute},
	} {
		allowed, retry, err := s.ItemsLimiter.Decide(r.Context(), lim.key, lim.limit, now)
		if err != nil {
			core.WriteRateStoreUnavailable(w, r)
			return
		}
		if !allowed {
			core.WriteRateLimited(w, r, retry, "Step items rate limit exceeded. Retry after the configured window.")
			return
		}
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	stepID := strings.TrimSpace(r.PathValue("stepId"))
	query := r.URL.Query()
	port := query.Get("port")
	if port == "" || len(port) > 128 || strings.TrimSpace(port) != port {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "port is required.")
		return
	}
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "limit must be a positive integer.")
			return
		}
		limit = min(n, wfstore.MaxListLimit)
	}
	binding := itemcursor.Binding{ExecutionID: executionID, StepID: stepID, Port: port}
	after := -1
	if raw := query.Get("cursor"); raw != "" {
		idx, err := s.ItemsCursor.Verify(raw, binding, now)
		if err != nil {
			core.WriteProblem(w, r, http.StatusBadRequest, CodeCursorInvalid, "Invalid Cursor", "The cursor is invalid or expired.")
			return
		}
		after = idx
	}
	page, err := store.ListStepItems(r.Context(), scope, wfstore.StepItemsQuery{
		ExecutionID: executionID, StepID: stepID, Port: port, AfterIdx: after, Limit: limit,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	resp := stepItemsResponse{Items: page.Items, Total: page.Total}
	if page.Next >= 0 {
		next, err := s.ItemsCursor.Sign(binding, page.Next, now)
		if err != nil {
			WriteWorkflowStoreError(w, r, err)
			return
		}
		resp.NextCursor = next
	}
	core.WriteJSON(w, http.StatusOK, resp)
}
