package rt

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// Workspace error workflow admin routes (#649 S3).

const errorWorkflowCommon = "Requires workspace.administer. An embed session is refused with 403 forbidden before permissions are read. There is no /embed/v1 surface. The workspace is the session workspace; there is no workspace id in the path."

const errorWorkflowStepUp = "PUT and DELETE also need MFA step-up on a local-login or OIDC session (403 mfa-required until TOTP is verified in this session), the same mechanism and freshness window as the other privileged admin routes."

var errorWorkflowOps = map[string]groupOp{
	"GET /api/v1/workspace/error-workflow": {
		summary: "Get the workspace error workflow",
		description: []string{
			"Returns the workflow the engine starts when an automated run in this workspace fails or ends indeterminate, or errorWorkflow null when none is set. The workflow is named by display name and UUID; the reference is kept even when that workflow is later deleted, unpublished or archived (the engine then skips it and audits the reason).",
		},
		success:     "200",
		successDesc: "The current setting.",
		successBody: "WorkspaceErrorWorkflow",
	},
	"PUT /api/v1/workspace/error-workflow": {
		summary: "Set the workspace error workflow",
		description: []string{
			"workflowId must be a published, not deleted workflow in this workspace whose latest version's only trigger is error (trigger type error, no fields). Anything else, including a workflow in another workspace, is 400 invalid-request with errors[].path workflowId, and nothing changes. Host-supplied workspace identity in the body is 400.",
			"The engine starts the error workflow, as a system run with no requester, in the transaction that ends a parent run: when the parent ends failed with a code onError may route (the S2 allowlist, or a flow.fail literal dotted code), or ends indeterminate (reason indeterminate). It never fires for manual runs, operator-retried runs, canceled or succeededWithErrors runs, a workflow delete, system/security/authz/policy codes, or the error workflow's own runs. At most one error run per parent.",
			"The error run's input is {reason, triggerType, executionId, workflowId, workflowName, workflowVersionId, workflowVersion, nodeId, code (max 64 bytes), message (max 256 bytes)}. It never carries the parent actor or the parent's input, trigger metadata or secrets.",
			"Writes audit action workspace.error_workflow.set (resource workspace, details actorId, actorDisplayName, workflowId, workflowName, previousWorkflowId) in the same transaction.",
		},
		requestBody: "PutWorkspaceErrorWorkflowRequest",
		success:     "200",
		successDesc: "Set.",
		successBody: "WorkspaceErrorWorkflow",
		extra:       []string{"400:InvalidRequest"},
	},
	"DELETE /api/v1/workspace/error-workflow": {
		summary: "Clear the workspace error workflow",
		description: []string{
			"Removes the setting. Idempotent: clearing an unset error workflow is 204 and writes no audit row. Error runs already started are not affected.",
			"Writes audit action workspace.error_workflow.cleared (resource workspace, details actorId, actorDisplayName, previousWorkflowId) in the same transaction.",
		},
		success:     "204",
		successDesc: "Cleared. No body.",
	},
}

func errorWorkflowOperation(rt Route, op groupOp) (*yaml.Node, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "operationId: %s\n", operationID(rt.Method, rt.OpenAPIPath()))
	fmt.Fprintf(&b, "summary: %s\n", op.summary)
	b.WriteString("description: |\n")
	for _, line := range op.description {
		fmt.Fprintf(&b, "  %s\n", line)
	}
	fmt.Fprintf(&b, "  %s\n", errorWorkflowCommon)
	if rt.Method != "GET" {
		fmt.Fprintf(&b, "  %s\n", errorWorkflowStepUp)
	}
	fmt.Fprintf(&b, "  Auth class: %s. Identity proxy: %s.\n", rt.Auth, rt.Proxy)
	b.WriteString("  Responses never include secrets, credentials, tokens, private keys, or vault material.\n")
	b.WriteString("parameters:\n")
	for _, p := range op.params {
		fmt.Fprintf(&b, "  - $ref: \"#/components/parameters/%s\"\n", p)
	}
	if op.requestBody != "" {
		b.WriteString("requestBody:\n  required: true\n  content:\n    application/json:\n      schema:\n")
		fmt.Fprintf(&b, "        $ref: \"#/components/schemas/%s\"\n", op.requestBody)
	}
	b.WriteString("responses:\n")
	fmt.Fprintf(&b, "  %q:\n", op.success)
	fmt.Fprintf(&b, "    description: %s\n", op.successDesc)
	if op.successBody != "" {
		b.WriteString("    content:\n      application/json:\n        schema:\n")
		fmt.Fprintf(&b, "          $ref: \"#/components/schemas/%s\"\n", op.successBody)
	}
	b.WriteString("  \"401\":\n    $ref: \"#/components/responses/Unauthenticated\"\n")
	b.WriteString("  \"403\":\n    $ref: \"#/components/responses/ScimTokenAdminForbidden\"\n")
	for _, e := range op.extra {
		code, ref, _ := strings.Cut(e, ":")
		fmt.Fprintf(&b, "  %q:\n    $ref: \"#/components/responses/%s\"\n", code, ref)
	}
	b.WriteString("  \"405\":\n    $ref: \"#/components/responses/MethodNotAllowed\"\n")
	b.WriteString("  \"500\":\n    $ref: \"#/components/responses/InternalError\"\n")
	b.WriteString("  \"503\":\n    $ref: \"#/components/responses/DependencyUnavailable\"\n")
	return unmarshalNode(b.String())
}
