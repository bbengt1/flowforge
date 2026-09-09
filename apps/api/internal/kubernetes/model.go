// Package kubernetes is the control-plane model for cluster targets and
// Kubernetes policy. E7.1 does not contact clusters; E7.2 workers consume
// this metadata when they resolve scoped credential handles.
package kubernetes

import (
	"fmt"
	"regexp"
	"strings"
)

// Vault credential type that may be bound to a cluster target.
const CredentialType = "kubernetes"

// Secret field name stored in the vault (never returned on ops-config APIs).
const CredentialSecretField = "kubeconfig"

// RoleTemplateNamespaceRunner is the only MVP Role/RoleBinding template.
const RoleTemplateNamespaceRunner = "namespace-scoped-runner"

// DefaultServiceAccountName is the least-privilege runner identity.
const DefaultServiceAccountName = "flowforge-runner"

// Template paths operators apply per workspace namespace. ClusterRoles are
// not part of MVP.
const (
	RoleTemplatePath        = "deploy/kubernetes/workspace-role-template.yaml"
	RoleBindingTemplatePath = "deploy/kubernetes/workspace-rolebinding-template.yaml"
	ServiceAccountPath      = "deploy/kubernetes/workspace-serviceaccount.yaml"
)

// Engine verbs used by kubernetes.* nodes. Cluster-scoped verbs are excluded.
var AllowedVerbs = []string{"get", "list", "apply", "watch"}

// AllowedKinds is the MVP namespace-scoped apply/read allowlist.
var AllowedKinds = []string{
	"ConfigMap",
	"Service",
	"Deployment",
	"StatefulSet",
	"DaemonSet",
	"Job",
	"CronJob",
	"Ingress",
	"NetworkPolicy",
}

var (
	dns1123LabelRE = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	kindRE         = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)
)

// ValidNamespace reports a DNS-1123 label suitable for a Kubernetes namespace.
func ValidNamespace(name string) bool {
	name = strings.TrimSpace(name)
	return name != "" && len(name) <= 63 && dns1123LabelRE.MatchString(name)
}

// ValidServiceAccountName reports a DNS-1123 label for a service account.
func ValidServiceAccountName(name string) bool {
	return ValidNamespace(name)
}

// ValidKind reports a PascalCase Kubernetes kind name.
func ValidKind(kind string) bool {
	kind = strings.TrimSpace(kind)
	return kind != "" && len(kind) <= 63 && kindRE.MatchString(kind)
}

// KindAllowed reports whether kind is on the engine allowlist.
func KindAllowed(kind string) bool {
	return containsFold(AllowedKinds, kind)
}

// VerbAllowed reports whether verb is an engine verb.
func VerbAllowed(verb string) bool {
	return containsFold(AllowedVerbs, verb)
}

// ValidRoleTemplate reports the closed set of SA role templates.
func ValidRoleTemplate(name string) bool {
	return strings.TrimSpace(name) == RoleTemplateNamespaceRunner
}

// NormalizeRoleTemplate returns the default template when empty.
func NormalizeRoleTemplate(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return RoleTemplateNamespaceRunner, nil
	}
	if !ValidRoleTemplate(name) {
		return "", fmt.Errorf("serviceAccount.roleTemplate must be %s (ClusterRoles are not MVP)", RoleTemplateNamespaceRunner)
	}
	return name, nil
}

func containsFold(items []string, want string) bool {
	want = strings.TrimSpace(want)
	for _, item := range items {
		if strings.EqualFold(item, want) {
			return true
		}
	}
	return false
}
