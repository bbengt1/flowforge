package workflowhttp

import (
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
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

func presentWorkflow(perms []string, actorID string, wf wfstore.Workflow) WorkflowView {
	return WorkflowView{
		Workflow: wf,
		Capabilities: WorkflowCapabilities{
			Delete: canDeleteWorkflow(perms, actorID, wf.CreatedBy),
		},
	}
}

func presentWorkflows(perms []string, actorID string, items []wfstore.Workflow) []WorkflowView {
	out := make([]WorkflowView, 0, len(items))
	for _, wf := range items {
		out = append(out, presentWorkflow(perms, actorID, wf))
	}
	return out
}

func canDeleteWorkflow(perms []string, actorID, createdBy string) bool {
	if authz.Allows(perms, authz.PermWorkflowDelete) {
		return true
	}
	actorID = strings.TrimSpace(actorID)
	createdBy = strings.TrimSpace(createdBy)
	return actorID != "" && createdBy != "" && actorID == createdBy
}
