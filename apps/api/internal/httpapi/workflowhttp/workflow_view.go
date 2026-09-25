package workflowhttp

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// WorkflowCapabilities is the caller-specific action set on a workflow response.
type WorkflowCapabilities struct {
	Delete bool `json:"delete"`
}

// WorkflowView is a workflow plus the caller's capabilities. The embedded
// record keeps the existing flat JSON shape.
type WorkflowView struct {
	wfstore.Workflow
	Capabilities WorkflowCapabilities `json:"capabilities"`
}

func presentWorkflow(perms []string, actorID string, wf wfstore.Workflow, embedSession bool) WorkflowView {
	return WorkflowView{
		Workflow: wf,
		Capabilities: WorkflowCapabilities{
			Delete: canDeleteWorkflow(perms, actorID, wf.CreatedBy, embedSession),
		},
	}
}

func presentWorkflows(perms []string, actorID string, items []wfstore.Workflow, embedSession bool) []WorkflowView {
	out := make([]WorkflowView, 0, len(items))
	for _, wf := range items {
		out = append(out, presentWorkflow(perms, actorID, wf, embedSession))
	}
	return out
}

// requestEmbedBound is true only for an embed session. A missing principal
// is not an embed session. Bound embed sessions fail closed on delete.
func requestEmbedBound(r *http.Request) bool {
	pc := core.PrincipalFromRequest(r)
	return pc != nil && pc.Session != nil && pc.Session.Binding.Bound()
}

// canDeleteWorkflow is the only authorization check that compares the
// caller to workflows.created_by. The owner grant is not added on an
// embed session: embed caps are the ceiling, and delete is refused
// before this function runs. Embed denial is 403 forbidden, and
// capabilities.delete stays false even when a stored session still
// lists workflow.delete.
func canDeleteWorkflow(perms []string, actorID, createdBy string, embedSession bool) bool {
	if embedSession {
		return false
	}
	if authz.Allows(perms, authz.PermWorkflowDelete) {
		return true
	}
	return ownerMayAdd(actorID, createdBy, embedSession)
}

// ownerMayAdd is the owner privilege after embed caps are applied.
// An embed session never receives a permission from ownership. The
// caller must already hold that permission in the intersected caps.
func ownerMayAdd(actorID, createdBy string, embedSession bool) bool {
	if embedSession {
		return false
	}
	actorID = strings.TrimSpace(actorID)
	createdBy = strings.TrimSpace(createdBy)
	return actorID != "" && createdBy != "" && actorID == createdBy
}
