package rt

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// groupOp documents one workspace group admin route.
type groupOp struct {
	summary     string
	description []string
	params      []string
	requestBody string
	success     string
	successDesc string
	successBody string
	extra       []string
}

const groupCommon = "Requires workspace.administer. An embed session is refused with 403 forbidden before permissions are read. " +
	"Groups only target approvals. They never grant a permission, and membership never grants approval.decide. " +
	"Another workspace's group is 404, the same as a missing group. A {groupId} path segment that is not a UUID is also 404, after the permission check. No response includes an email address."

const managedNote = "While the instance runs SCIM_GROUPS_MODE=groups, this change on a group with managedBy \"scim\" is 409 group_managed_by_scim and nothing changes; in workspaces mode it is allowed."

const gateRecheckNote = "Waiting targeted approval gates that name the group are re-checked in the same transaction: a gate left with no eligible decider is closed the same way as at park time (execution failed with requirement_unresolvable, cause no_eligible_decider); a gate that still has an eligible decider keeps waiting."

var workspaceGroupOps = map[string]groupOp{
	"GET /api/v1/workspace/groups": {
		summary: "List workspace groups",
		description: []string{
			"Lists the workspace's groups ordered by display name without regard to case, then id. Paged like other collections (limit, cursor, q over displayName).",
			"memberCount counts every membership row, including a disabled user who still has rows.",
			"managedBy is \"scim\" for a group a workspace SCIM token manages and null for a local group.",
		},
		params:      []string{"PageLimit", "PageCursor", "PageSearch"},
		success:     "200",
		successDesc: "One page of groups.",
		successBody: "WorkspaceGroupList",
		extra:       []string{"400:InvalidRequest"},
	},
	"POST /api/v1/workspace/groups": {
		summary: "Create a workspace group",
		description: []string{
			"Creates an empty group. displayName is trimmed and must be 1-128 characters; otherwise 400 invalid-request with errors[].path displayName.",
			"A name already used in the workspace, compared without regard to case, is 409 group_name_taken with errors[].path displayName. That includes a create that loses a race on the unique index.",
			"Writes audit action workspace_group.create in the same transaction.",
		},
		requestBody: "CreateWorkspaceGroupRequest",
		success:     "201",
		successDesc: "Created group.",
		successBody: "WorkspaceGroup",
		extra:       []string{"400:InvalidRequest", "409:GroupNameTaken"},
	},
	"GET /api/v1/workspace/groups/{groupId}": {
		summary: "Get a workspace group and its members",
		description: []string{
			"Returns the group and every member row as userId, displayName, and canApprove.",
			"canApprove is computed by the server: true only when the user is active, has a live role binding in this workspace, and those roles grant approval.decide.",
			"A user removed from the workspace is not listed because removal deletes their group rows. A disabled user who still has rows stays listed with canApprove false.",
		},
		params:      []string{"WorkspaceGroupID"},
		success:     "200",
		successDesc: "Group detail.",
		successBody: "WorkspaceGroupDetail",
		extra:       []string{"404:NotFound"},
	},
	"PATCH /api/v1/workspace/groups/{groupId}": {
		summary: "Rename a workspace group",
		description: []string{
			"Sets displayName. Same validation and 409 group_name_taken rules as create, including a rename that loses a race on the unique index. Renaming a group to its own name in another case is allowed.",
			"Writes audit action workspace_group.rename in the same transaction when the name changes. A rename to the exact current name (after trimming) changes nothing and writes no audit row.",
			"Only displayName changes: the group id, which workflow approvers.groups reference, never changes.",
			managedNote,
		},
		params:      []string{"WorkspaceGroupID"},
		requestBody: "UpdateWorkspaceGroupRequest",
		success:     "200",
		successDesc: "Renamed group.",
		successBody: "WorkspaceGroup",
		extra:       []string{"400:InvalidRequest", "404:NotFound", "409:RenameGroupConflict"},
	},
	"DELETE /api/v1/workspace/groups/{groupId}": {
		summary: "Delete a workspace group",
		description: []string{
			"Hard-deletes the group and its membership rows. There is no restore.",
			"Workflow YAML that still names the deleted group id resolves to nobody, so that approval target fails closed.",
			"Writes audit action workspace_group.delete in the same transaction.",
			gateRecheckNote,
			managedNote,
		},
		params:      []string{"WorkspaceGroupID"},
		success:     "204",
		successDesc: "Deleted. No body.",
		extra:       []string{"404:NotFound", "409:GroupManagedBySCIM"},
	},
	"POST /api/v1/workspace/groups/{groupId}/members": {
		summary: "Add a workspace group member",
		description: []string{
			"Adds userId to the group. Idempotent: adding an existing member is 204 and writes no second row.",
			"The user must be active and hold a role binding in this workspace; otherwise 400 group_member_not_in_workspace with errors[].path userId. A userId that is not a UUID is 400 invalid-request with errors[].path userId.",
			"Writes audit action workspace_group.member_add when a row is added.",
			managedNote,
		},
		params:      []string{"WorkspaceGroupID"},
		requestBody: "AddWorkspaceGroupMemberRequest",
		success:     "204",
		successDesc: "Member present. No body.",
		extra:       []string{"400:AddGroupMemberInvalid", "404:NotFound", "409:GroupManagedBySCIM"},
	},
	"DELETE /api/v1/workspace/groups/{groupId}/members/{userId}": {
		summary: "Remove a workspace group member",
		description: []string{
			"Removes userId from the group. Idempotent: removing a user who is not a member is 204. A userId path segment that is not a UUID is 400 invalid-request with errors[].path userId, the same status and code as DELETE /api/v1/workspace/members/{userID}.",
			"Writes audit action workspace_group.member_remove when a row is removed.",
			gateRecheckNote,
			managedNote,
		},
		params:      []string{"WorkspaceGroupID", "WorkspaceGroupUserID"},
		success:     "204",
		successDesc: "Member absent. No body.",
		extra:       []string{"400:InvalidRequest", "404:NotFound", "409:GroupManagedBySCIM"},
	},
}

func workspaceGroupOperation(rt Route, op groupOp) (*yaml.Node, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "operationId: %s\n", operationID(rt.Method, rt.OpenAPIPath()))
	fmt.Fprintf(&b, "summary: %s\n", op.summary)
	b.WriteString("description: |\n")
	for _, line := range op.description {
		fmt.Fprintf(&b, "  %s\n", line)
	}
	fmt.Fprintf(&b, "  %s\n", groupCommon)
	fmt.Fprintf(&b, "  Auth class: %s. Identity proxy: %s.\n", rt.Auth, rt.Proxy)
	b.WriteString("  Responses never include secrets, credentials, tokens, private keys, or vault material.\n")
	if len(op.params) > 0 {
		b.WriteString("parameters:\n")
		for _, p := range op.params {
			fmt.Fprintf(&b, "  - $ref: \"#/components/parameters/%s\"\n", p)
		}
	}
	if op.requestBody != "" {
		b.WriteString("requestBody:\n")
		b.WriteString("  required: true\n")
		b.WriteString("  content:\n")
		b.WriteString("    application/json:\n")
		b.WriteString("      schema:\n")
		fmt.Fprintf(&b, "        $ref: \"#/components/schemas/%s\"\n", op.requestBody)
	}
	b.WriteString("responses:\n")
	fmt.Fprintf(&b, "  %q:\n", op.success)
	fmt.Fprintf(&b, "    description: %s\n", op.successDesc)
	if op.successBody != "" {
		b.WriteString("    content:\n")
		b.WriteString("      application/json:\n")
		b.WriteString("        schema:\n")
		fmt.Fprintf(&b, "          $ref: \"#/components/schemas/%s\"\n", op.successBody)
	}
	b.WriteString("  \"401\":\n")
	b.WriteString("    $ref: \"#/components/responses/Unauthenticated\"\n")
	b.WriteString("  \"403\":\n")
	b.WriteString("    description: Caller lacks workspace.administer, or the caller is an embed session.\n")
	for _, e := range op.extra {
		code, ref, _ := strings.Cut(e, ":")
		fmt.Fprintf(&b, "  %q:\n", code)
		fmt.Fprintf(&b, "    $ref: \"#/components/responses/%s\"\n", ref)
	}
	b.WriteString("  \"405\":\n")
	b.WriteString("    $ref: \"#/components/responses/MethodNotAllowed\"\n")
	b.WriteString("  \"500\":\n")
	b.WriteString("    $ref: \"#/components/responses/InternalError\"\n")
	b.WriteString("  \"503\":\n")
	b.WriteString("    $ref: \"#/components/responses/DependencyUnavailable\"\n")
	return unmarshalNode(b.String())
}
