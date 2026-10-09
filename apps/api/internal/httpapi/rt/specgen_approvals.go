package rt

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// approvalOperation documents the approval routes whose contract carries
// approver targeting: list (awaiting=me), approver candidates, and decide.
func approvalOperation(rt Route) (*yaml.Node, bool, error) {
	var b strings.Builder
	header := func(summary string, lines ...string) {
		fmt.Fprintf(&b, "operationId: %s\n", operationID(rt.Method, rt.OpenAPIPath()))
		fmt.Fprintf(&b, "summary: %s\n", summary)
		b.WriteString("description: |\n")
		for _, l := range lines {
			fmt.Fprintf(&b, "  %s\n", l)
		}
		fmt.Fprintf(&b, "  Auth class: %s. Identity proxy: %s.\n", rt.Auth, rt.Proxy)
		b.WriteString("  Responses never include secrets, credentials, tokens, private keys, or vault material.\n")
	}
	tail := func(extra ...string) {
		b.WriteString("  \"401\":\n    $ref: \"#/components/responses/Unauthenticated\"\n")
		for _, e := range extra {
			b.WriteString(e)
		}
		b.WriteString("  \"405\":\n    $ref: \"#/components/responses/MethodNotAllowed\"\n")
		b.WriteString("  \"500\":\n    $ref: \"#/components/responses/InternalError\"\n")
	}
	switch rt.Method + " " + rt.Pattern {
	case "GET /api/v1/approvals":
		header("List approvals",
			"Requires approval.view. Paged (limit, cursor).",
			"status=pending is the actionable inbox: pending rows the caller could decide now. An untargeted gate is actionable for holders of its role (or admin). A targeted gate is actionable for a snapshot user, a live member of a snapshot group, and any workspace admin who is not the requester (capabilities.decide.via admin_override).",
			"awaiting=me narrows to pending rows that are untargeted and actionable, or targeted at the caller as a snapshot user or a live group member. It never includes a row the caller could decide only by admin override.",
			"A machine principal never decides, so no row is actionable or awaiting it and its capabilities.decide is always false.",
			"Each item carries approvers (targeted gates only; display name and UUID) and capabilities.decide for the caller.",
		)
		b.WriteString("parameters:\n")
		b.WriteString("  - $ref: \"#/components/parameters/PageLimit\"\n")
		b.WriteString("  - $ref: \"#/components/parameters/PageCursor\"\n")
		b.WriteString("  - name: status\n    in: query\n    required: false\n    schema:\n      type: string\n      enum: [pending, approved, rejected, expired, invalidated, canceled]\n")
		b.WriteString("  - name: awaiting\n    in: query\n    required: false\n    description: me is the only value. Any other value is 400 invalid-request.\n    schema:\n      type: string\n      enum: [me]\n")
		b.WriteString("  - name: workflowId\n    in: query\n    required: false\n    schema: {type: string, format: uuid}\n")
		b.WriteString("  - name: workflowVersionId\n    in: query\n    required: false\n    schema: {type: string, format: uuid}\n")
		b.WriteString("responses:\n  \"200\":\n    description: One page of approvals.\n    content:\n      application/json:\n        schema:\n          $ref: \"#/components/schemas/ApprovalList\"\n")
		b.WriteString("  \"400\":\n    $ref: \"#/components/responses/InvalidRequest\"\n")
		tail("  \"403\":\n    $ref: \"#/components/responses/Forbidden\"\n")
	case "GET /api/v1/approvals/approver-candidates":
		header("List approver candidates for the builder",
			"Requires workflow.edit. Returns users and groups a gate may name in with.approvers.",
			"users are active workspace members who are people, never machine principals, whose roles grant approval.decide and meet role (exact role or admin). groups are every workspace group, including empty ones; membership is checked live when a gate is decided, and machine members never count.",
			"Display name and UUID only. No emails, no role details, no member lists. role must be a known role key; otherwise 400 invalid-request with errors[].path role.",
			"An embed session is refused with 403 forbidden.",
		)
		b.WriteString("parameters:\n")
		b.WriteString("  - name: role\n    in: query\n    required: true\n    description: The gate's approverRole.\n    schema: {type: string}\n")
		b.WriteString("responses:\n  \"200\":\n    description: Candidates.\n    content:\n      application/json:\n        schema:\n          $ref: \"#/components/schemas/ApproverCandidateList\"\n")
		b.WriteString("  \"400\":\n    $ref: \"#/components/responses/InvalidRequest\"\n")
		tail("  \"403\":\n    $ref: \"#/components/responses/Forbidden\"\n")
	case "POST /api/v1/approvals/{approvalId}/decide":
		header("Decide an approval",
			"Records an approve or reject decision and resumes a waiting gate.",
			"Order: 401 without a principal; 403 forbidden without approval.decide; 404 when the approval is not in the workspace; 409 approval_closed for a deleted workflow; rebuild the pinned requirement (transient 503); under the approval row lock 409 approval_closed when closed or not waiting, 403 forbidden for self-approval (the requester can never decide, even as admin), 409 when expired, invalidated, or not pending; 403 forbidden on a role mismatch.",
			"Then 403 forbidden, with nothing recorded, when the caller's account is disabled or is a machine principal, read in the decide transaction; this covers the admin override route too. Only a person approves.",
			"Approver check on a targeted gate: allowed when the caller is in the park-time user snapshot or a live member of a snapshot group (via target). Otherwise a workspace admin who is not the requester is allowed (via admin_override) and the decision writes audit action approval.decided_by_admin_override. Otherwise 403 approver_not_targeted, with nothing recorded.",
			"The decide transaction locks the approval row and then only the group membership row it matches (FOR SHARE). Role bindings are read without a lock.",
			"A database, network, or timeout failure while rebuilding the pinned requirement or reading targets returns 503 approval_requirement_unavailable.",
			"That response sets Retry-After to 5, records nothing, and changes nothing. The problem document has no errors array.",
		)
		b.WriteString("responses:\n")
		b.WriteString("  \"200\":\n    description: Decision recorded.\n")
		tail("  \"403\":\n    $ref: \"#/components/responses/ApprovalDecideForbidden\"\n",
			"  \"503\":\n    $ref: \"#/components/responses/ApprovalRequirementUnavailable\"\n")
	default:
		return nil, false, nil
	}
	node, err := unmarshalNode(b.String())
	return node, true, err
}
