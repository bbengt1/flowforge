// Package authz is the deny-by-default permission matrix and workspace-identity
// rules for the control plane. Database rows persist bindings; this package is
// the evaluation gate for unknown actions and host-supplied workspace IDs.
package authz

import "slices"

// Permission families required by E2.1.
const (
	FamilyView           = "view"
	FamilyEdit           = "edit"
	FamilyPublish        = "publish"
	FamilyExecute        = "execute"
	FamilyCredential     = "credential"
	FamilyApproval       = "approval"
	FamilyAdministration = "administration"
)

// Permission keys. Stable API/DB vocabulary.
const (
	PermWorkflowView        = "workflow.view"
	PermWorkflowEdit        = "workflow.edit"
	PermWorkflowPublish     = "workflow.publish"
	PermWorkflowExecute     = "workflow.execute"
	PermExecutionView       = "execution.view"
	PermExecutionCancel     = "execution.cancel"
	PermCredentialView      = "credential.view"
	PermCredentialUse       = "credential.use"
	PermCredentialManage    = "credential.manage"
	PermApprovalView        = "approval.view"
	PermApprovalDecide      = "approval.decide"
	PermAlertView           = "alert.view"
	PermAlertAck            = "alert.ack"
	PermWorkspaceAdminister = "workspace.administer"
	PermPlatformAdminister  = "platform.administer"
	PermEmbedImpersonate    = "embed.impersonate"
	PermKubernetesApply     = "kubernetes.apply"
	PermKubernetesRead      = "kubernetes.read"
	PermSSHRun              = "ssh.run"
	PermScriptRun           = "script.run"
	PermScriptRevoke        = "script.revoke"
	PermScriptEmergencyStop = "script.emergencyStop"
	PermOpsConfigView       = "opsconfig.view"
	PermOpsConfigEdit       = "opsconfig.edit"
	PermOpsConfigPublish    = "opsconfig.publish"
	PermOpsConfigUse        = "opsconfig.use"
	PermClusterTargetUse    = "clusterTarget.use"
	PermSSHTargetUse        = "sshTarget.use"
	PermCommandProfileUse   = "commandProfile.use"
	PermRuntimeProfileUse   = "runtimeProfile.use"
	PermConnectionUse       = "connection.use"
	PermRecipientListUse    = "recipientList.use"
	PermMessageTemplateUse  = "messageTemplate.use"
	PermResponseSchemaUse   = "responseSchema.use"
	PermPolicyUse           = "policy.use"
)

// Role keys.
const (
	RoleViewer        = "viewer"
	RoleEditor        = "editor"
	RolePublisher     = "publisher"
	RoleOperator      = "operator"
	RoleApprover      = "approver"
	RoleAdmin         = "admin"
	RolePlatformAdmin = "platform-admin"
)

// Permission is a catalog entry.
type Permission struct {
	Key    string `json:"key"`
	Family string `json:"family"`
}

// Role is a catalog entry with its granted permissions.
type Role struct {
	Key         string   `json:"key"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

// Permissions is the complete E2.1 matrix vocabulary.
func Permissions() []Permission {
	return []Permission{
		{Key: PermWorkflowView, Family: FamilyView},
		{Key: PermWorkflowEdit, Family: FamilyEdit},
		{Key: PermWorkflowPublish, Family: FamilyPublish},
		{Key: PermWorkflowExecute, Family: FamilyExecute},
		{Key: PermExecutionView, Family: FamilyView},
		{Key: PermExecutionCancel, Family: FamilyExecute},
		{Key: PermCredentialView, Family: FamilyCredential},
		{Key: PermCredentialUse, Family: FamilyCredential},
		{Key: PermCredentialManage, Family: FamilyCredential},
		{Key: PermApprovalView, Family: FamilyApproval},
		{Key: PermApprovalDecide, Family: FamilyApproval},
		{Key: PermAlertView, Family: FamilyView},
		{Key: PermAlertAck, Family: FamilyExecute},
		{Key: PermWorkspaceAdminister, Family: FamilyAdministration},
		{Key: PermPlatformAdminister, Family: FamilyAdministration},
		{Key: PermEmbedImpersonate, Family: FamilyAdministration},
		{Key: PermKubernetesApply, Family: FamilyExecute},
		{Key: PermKubernetesRead, Family: FamilyExecute},
		{Key: PermSSHRun, Family: FamilyExecute},
		{Key: PermScriptRun, Family: FamilyExecute},
		{Key: PermScriptRevoke, Family: FamilyExecute},
		{Key: PermScriptEmergencyStop, Family: FamilyExecute},
		{Key: PermOpsConfigView, Family: FamilyView},
		{Key: PermOpsConfigEdit, Family: FamilyEdit},
		{Key: PermOpsConfigPublish, Family: FamilyPublish},
		{Key: PermOpsConfigUse, Family: FamilyExecute},
		{Key: PermClusterTargetUse, Family: FamilyExecute},
		{Key: PermSSHTargetUse, Family: FamilyExecute},
		{Key: PermCommandProfileUse, Family: FamilyExecute},
		{Key: PermRuntimeProfileUse, Family: FamilyExecute},
		{Key: PermConnectionUse, Family: FamilyExecute},
		{Key: PermRecipientListUse, Family: FamilyExecute},
		{Key: PermMessageTemplateUse, Family: FamilyExecute},
		{Key: PermResponseSchemaUse, Family: FamilyExecute},
		{Key: PermPolicyUse, Family: FamilyExecute},
	}
}

// Roles is the seeded role vocabulary and grants.
func Roles() []Role {
	return []Role{
		{
			Key:         RoleViewer,
			Description: "Read workflows, executions, and approval status. Cannot edit, run, or manage credentials.",
			Permissions: []string{PermWorkflowView, PermExecutionView, PermApprovalView, PermOpsConfigView, PermAlertView},
		},
		{
			Key:         RoleEditor,
			Description: "Create and edit workflow drafts. Cannot publish, execute, or administer the workspace.",
			Permissions: []string{PermWorkflowView, PermWorkflowEdit, PermExecutionView, PermCredentialView, PermApprovalView, PermOpsConfigView, PermOpsConfigEdit, PermAlertView},
		},
		{
			Key:         RolePublisher,
			Description: "Edit and publish workflow versions. Cannot execute or administer.",
			Permissions: []string{PermWorkflowView, PermWorkflowEdit, PermWorkflowPublish, PermExecutionView, PermCredentialView, PermApprovalView, PermOpsConfigView, PermOpsConfigEdit, PermOpsConfigPublish, PermAlertView},
		},
		{
			Key:         RoleOperator,
			Description: "Execute published workflows and use credentials. Cannot edit definitions or administer.",
			Permissions: []string{
				PermWorkflowView, PermWorkflowExecute, PermExecutionView, PermExecutionCancel,
				PermCredentialView, PermCredentialUse, PermApprovalView, PermKubernetesApply, PermKubernetesRead, PermSSHRun, PermScriptRun,
				PermScriptRevoke, PermScriptEmergencyStop,
				PermAlertView, PermAlertAck,
				PermOpsConfigView, PermOpsConfigUse,
				PermClusterTargetUse, PermSSHTargetUse, PermCommandProfileUse, PermRuntimeProfileUse,
				PermConnectionUse, PermRecipientListUse, PermMessageTemplateUse, PermResponseSchemaUse, PermPolicyUse,
			},
		},
		{
			Key:         RoleApprover,
			Description: "Decide pending approvals. Cannot edit, execute, or administer.",
			Permissions: []string{PermWorkflowView, PermExecutionView, PermApprovalView, PermApprovalDecide, PermAlertView},
		},
		{
			Key:         RoleAdmin,
			Description: "Full workspace administration including membership, credentials, and all workspace actions. Does not grant platform.administer or embed.impersonate.",
			Permissions: WorkspacePermissionKeys(),
		},
		{
			Key:         RolePlatformAdmin,
			Description: "Platform-scoped operations (tenant/workspace bootstrap, global embed overlap key rotation, and embed.impersonate). Not assignable via workspace membership; granted only by PLATFORM_ADMINS.",
			Permissions: []string{PermPlatformAdminister, PermEmbedImpersonate},
		},
	}
}

// PermissionKeys returns every catalog permission key.
func PermissionKeys() []string {
	all := Permissions()
	out := make([]string, 0, len(all))
	for _, p := range all {
		out = append(out, p.Key)
	}
	return out
}

// PlatformScopedPermission reports whether key is granted only by the
// platform-admin allowlist, never by a workspace role binding.
func PlatformScopedPermission(key string) bool {
	return key == PermPlatformAdminister || key == PermEmbedImpersonate
}

// WorkspacePermissionKeys is every catalog permission except platform-scoped ones.
func WorkspacePermissionKeys() []string {
	all := Permissions()
	out := make([]string, 0, len(all))
	for _, p := range all {
		if PlatformScopedPermission(p.Key) {
			continue
		}
		out = append(out, p.Key)
	}
	return out
}

// WorkspaceAssignableRole reports whether role may be bound via workspace membership.
func WorkspaceAssignableRole(role string) bool {
	return KnownRole(role) && role != RolePlatformAdmin
}

// RequiredFamilies is the E2.1 acceptance set.
func RequiredFamilies() []string {
	return []string{
		FamilyView, FamilyEdit, FamilyPublish, FamilyExecute,
		FamilyCredential, FamilyApproval, FamilyAdministration,
	}
}

// Known reports whether action is in the catalog.
func Known(action string) bool {
	for _, p := range Permissions() {
		if p.Key == action {
			return true
		}
	}
	return false
}

// KnownRole reports whether role is in the catalog.
func KnownRole(role string) bool {
	for _, r := range Roles() {
		if r.Key == role {
			return true
		}
	}
	return false
}

// Allows is deny-by-default: unknown, empty, or ungranted actions are denied.
func Allows(granted []string, action string) bool {
	if action == "" || !Known(action) {
		return false
	}
	return slices.Contains(granted, action)
}

// ExpandRoles unions permissions for the given role keys. Unknown roles add nothing.
func ExpandRoles(roleKeys []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, role := range Roles() {
		if !slices.Contains(roleKeys, role.Key) {
			continue
		}
		for _, perm := range role.Permissions {
			if _, ok := seen[perm]; ok {
				continue
			}
			seen[perm] = struct{}{}
			out = append(out, perm)
		}
	}
	return out
}

// ExpandWorkspaceRoles expands only workspace-assignable roles. A
// platform-admin binding in workspace_role_bindings grants nothing.
func ExpandWorkspaceRoles(roleKeys []string) []string {
	filtered := make([]string, 0, len(roleKeys))
	for _, role := range roleKeys {
		if WorkspaceAssignableRole(role) {
			filtered = append(filtered, role)
		}
	}
	return ExpandRoles(filtered)
}
