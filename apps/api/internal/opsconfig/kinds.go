// Package opsconfig persists workspace-scoped operational configuration
// with mutable drafts and immutable published revisions.
package opsconfig

import (
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	ssheng "github.com/bbengt1/flowforge/apps/api/internal/ssh"
)

// Resource kinds. Stable API/DB vocabulary.
const (
	KindClusterTarget   = "cluster_target"
	KindSSHTarget       = "ssh_target"
	KindCommandProfile  = "command_profile"
	KindRuntimeProfile  = "runtime_profile"
	KindConnection      = "connection"
	KindRecipientList   = "recipient_list"
	KindMessageTemplate = "message_template"
	KindResponseSchema  = "response_schema"
	KindPolicy          = "policy"
)

// Resource statuses.
const (
	StatusDraft     = "draft"
	StatusPublished = "published"
	StatusDisabled  = "disabled"
)

// Pin owner kinds.
const (
	OwnerWorkflowVersion = "workflow_version"
	OwnerExecution       = "execution"
)

// YAML with-field names that reference an ops resource UUID.
const (
	YAMLClusterTargetID   = "clusterTargetId"
	YAMLSSHTargetID       = "sshTargetId"
	YAMLCommandProfileID  = "commandProfileId"
	YAMLRuntimeProfileID  = "runtimeProfileId"
	YAMLConnectionID      = "connectionId"
	YAMLRecipientListID   = "recipientListId"
	YAMLTemplateID        = "templateId"
	YAMLMessageTemplateID = "messageTemplateId"
	YAMLResponseSchemaRef = "responseSchemaRef"
	YAMLResponseSchemaID  = "responseSchemaId"
	YAMLPolicyID          = "policyId"
)

// KindInfo describes one operational configuration kind for the catalog.
type KindInfo struct {
	Kind                   string   `json:"kind"`
	Collection             string   `json:"collection"`
	DisplayName            string   `json:"displayName"`
	YAMLFields             []string `json:"yamlFields"`
	UsePermission          string   `json:"usePermission"`
	AllowedCredentialTypes []string `json:"allowedCredentialTypes,omitempty"`
	Engine                 string   `json:"engine,omitempty"`
}

// Kinds is the closed set of operational configuration kinds.
func Kinds() []string {
	return []string{
		KindClusterTarget, KindSSHTarget, KindCommandProfile, KindRuntimeProfile,
		KindConnection, KindRecipientList, KindMessageTemplate, KindResponseSchema, KindPolicy,
	}
}

// KindInfos is the UI/OpenAPI catalog.
func KindInfos() []KindInfo {
	return []KindInfo{
		{Kind: KindClusterTarget, Collection: "cluster-targets", DisplayName: "Cluster target", YAMLFields: []string{YAMLClusterTargetID}, UsePermission: authz.PermClusterTargetUse, AllowedCredentialTypes: []string{kubernetes.CredentialType}, Engine: "kubernetes"},
		{Kind: KindSSHTarget, Collection: "ssh-targets", DisplayName: "SSH target", YAMLFields: []string{YAMLSSHTargetID}, UsePermission: authz.PermSSHTargetUse, AllowedCredentialTypes: []string{ssheng.CredentialType}, Engine: "ssh"},
		{Kind: KindCommandProfile, Collection: "command-profiles", DisplayName: "Command profile", YAMLFields: []string{YAMLCommandProfileID}, UsePermission: authz.PermCommandProfileUse, Engine: "ssh"},
		{Kind: KindRuntimeProfile, Collection: "runtime-profiles", DisplayName: "Runtime profile", YAMLFields: []string{YAMLRuntimeProfileID}, UsePermission: authz.PermRuntimeProfileUse, Engine: "script"},
		{Kind: KindConnection, Collection: "connections", DisplayName: "Connection", YAMLFields: []string{YAMLConnectionID}, UsePermission: authz.PermConnectionUse, AllowedCredentialTypes: []string{"token"}, Engine: "http-notification"},
		{Kind: KindRecipientList, Collection: "recipient-lists", DisplayName: "Recipient list", YAMLFields: []string{YAMLRecipientListID}, UsePermission: authz.PermRecipientListUse},
		{Kind: KindMessageTemplate, Collection: "message-templates", DisplayName: "Message template", YAMLFields: []string{YAMLTemplateID, YAMLMessageTemplateID}, UsePermission: authz.PermMessageTemplateUse},
		{Kind: KindResponseSchema, Collection: "response-schemas", DisplayName: "Response schema", YAMLFields: []string{YAMLResponseSchemaRef, YAMLResponseSchemaID}, UsePermission: authz.PermResponseSchemaUse},
		{Kind: KindPolicy, Collection: "policies", DisplayName: "Policy", YAMLFields: []string{YAMLPolicyID}, UsePermission: authz.PermPolicyUse},
	}
}

// ValidKind reports whether kind is a known ops-config kind.
func ValidKind(kind string) bool {
	for _, k := range Kinds() {
		if k == kind {
			return true
		}
	}
	return false
}

// CollectionFor returns the stable URL collection for kind.
func CollectionFor(kind string) string {
	for _, info := range KindInfos() {
		if info.Kind == kind {
			return info.Collection
		}
	}
	return ""
}

// KindForCollection maps a URL collection to a kind.
func KindForCollection(collection string) string {
	for _, info := range KindInfos() {
		if info.Collection == collection {
			return info.Kind
		}
	}
	return ""
}

// UsePermissionFor is the deny-by-default use action for a kind.
func UsePermissionFor(kind string) string {
	for _, info := range KindInfos() {
		if info.Kind == kind {
			return info.UsePermission
		}
	}
	return ""
}

// YAMLFieldKind maps a workflow `with` key to an ops-config kind.
func YAMLFieldKind(field string) string {
	switch field {
	case YAMLClusterTargetID:
		return KindClusterTarget
	case YAMLSSHTargetID:
		return KindSSHTarget
	case YAMLCommandProfileID:
		return KindCommandProfile
	case YAMLRuntimeProfileID:
		return KindRuntimeProfile
	case YAMLConnectionID:
		return KindConnection
	case YAMLRecipientListID:
		return KindRecipientList
	case YAMLTemplateID, YAMLMessageTemplateID:
		return KindMessageTemplate
	case YAMLResponseSchemaRef, YAMLResponseSchemaID:
		return KindResponseSchema
	case YAMLPolicyID:
		return KindPolicy
	default:
		return ""
	}
}

// Collections is every stable URL collection (for mux registration).
func Collections() []string {
	infos := KindInfos()
	out := make([]string, 0, len(infos))
	for _, info := range infos {
		out = append(out, info.Collection)
	}
	return out
}
