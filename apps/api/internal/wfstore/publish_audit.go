package wfstore

import "github.com/bbengt1/flowforge/apps/api/internal/isolation"

// ActionWorkflowPublish is the audit action for a new live version.
const ActionWorkflowPublish = "workflow.publish"

// publishAudit is the workflow.publish row. It carries identifiers, the
// version number, digest and note only: never spec or YAML.
func publishAudit(scope isolation.Scope, actorDisplayName, workflowID string, ver Version) AuditWrite {
	details := map[string]any{
		"actorId":       scope.ActorID(),
		"workspaceId":   scope.WorkspaceID(),
		"workflowId":    workflowID,
		"versionId":     ver.ID,
		"versionNumber": ver.VersionNumber,
		"digest":        ver.Digest,
		"note":          ver.PublishNote,
	}
	if actorDisplayName != "" {
		details["actorDisplayName"] = actorDisplayName
	}
	if tenantID := scope.TenantID(); tenantID != "" {
		details["tenantId"] = tenantID
	}
	return AuditWrite{
		Action:       ActionWorkflowPublish,
		ResourceType: "workflow",
		ResourceID:   workflowID,
		Outcome:      "published",
		Details:      details,
	}
}
