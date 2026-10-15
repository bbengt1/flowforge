package workflowhttp

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.2 §4a: draft expression type-check. It shares the publish checker
// and codes, never evaluates, and returns types, codes and paths only.
// References resolve only inside the stored draft. Drafts still never run.

const (
	TypecheckPrincipalPerMinute = 60
	TypecheckWorkspacePerMinute = 300
)

type typecheckError struct {
	Path    string `json:"path"`
	NodeID  string `json:"nodeId,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type typecheckResponse struct {
	OK              bool                      `json:"ok"`
	CatalogRevision int                       `json:"catalogRevision"`
	DraftRevision   int64                     `json:"draftRevision"`
	Expressions     []workflow.ExpressionType `json:"expressions"`
	Errors          []typecheckError          `json:"errors"`
}

func typecheckWorkflowDraft(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	if s.TypecheckLimiter == nil {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Type check is not available.")
		return
	}
	now := s.ClockNow()
	for _, lim := range []struct {
		key   string
		limit int
	}{
		{"typecheck-principal:" + scope.ActorID(), TypecheckPrincipalPerMinute},
		{"typecheck-workspace:" + scope.WorkspaceID(), TypecheckWorkspacePerMinute},
	} {
		allowed, retry, err := s.TypecheckLimiter.Decide(r.Context(), lim.key, lim.limit, now)
		if err != nil {
			core.WriteRateStoreUnavailable(w, r)
			return
		}
		if !allowed {
			core.WriteRateLimited(w, r, retry, "Type check rate limit exceeded. Retry after the configured window.")
			return
		}
	}
	draft, err := s.Workflows.GetDraft(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	resp := typecheckResponse{
		CatalogRevision: workflow.CatalogRevision,
		DraftRevision:   draft.Revision,
		Expressions:     []workflow.ExpressionType{},
		Errors:          []typecheckError{},
	}
	res, errs := workflow.ParseAndNormalize([]byte(draft.DefinitionYAML))
	if len(errs) == 0 {
		var report workflow.ExpressionReport
		report, errs = workflow.CheckExpressions(res.Document)
		resp.Expressions = report.Types()
	}
	for _, e := range errs {
		resp.Errors = append(resp.Errors, typecheckError{Path: e.Path, NodeID: e.NodeID, Code: e.Code, Message: e.Message})
	}
	resp.OK = len(resp.Errors) == 0
	core.WriteJSON(w, http.StatusOK, resp)
}
