package kubernetes

// ServiceAccountCatalog is least-privilege SA metadata for operators and E7.2.
type ServiceAccountCatalog struct {
	DefaultName        string `json:"defaultName"`
	RoleTemplate       string `json:"roleTemplate"`
	RoleTemplatePath   string `json:"roleTemplatePath"`
	RoleBindingPath    string `json:"roleBindingTemplatePath"`
	ServiceAccountPath string `json:"serviceAccountPath"`
	ClusterRoles       bool   `json:"clusterRoles"`
	Notes              string `json:"notes"`
}

// PublishRules documents fail-closed publish/select constraints.
type PublishRules struct {
	ClusterTargetRequired      []string `json:"clusterTargetRequired"`
	KubernetesPolicyRequired   []string `json:"kubernetesPolicyRequired"`
	EmptyAllowlistsRejected    bool     `json:"emptyAllowlistsRejected"`
	CredentialType             string   `json:"credentialType"`
	DenyAllowsMissingAllowlist bool     `json:"denyAllowsMissingAllowlist"`
}

// EngineCatalog is the Chloe / worker vocabulary for E7.1.
type EngineCatalog struct {
	CredentialType        string                `json:"credentialType"`
	CredentialSecretField string                `json:"credentialSecretField"`
	AllowedKinds          []string              `json:"allowedKinds"`
	AllowedVerbs          []string              `json:"allowedVerbs"`
	EvaluationKeys        []EvaluationKey       `json:"evaluationKeys"`
	ServiceAccount        ServiceAccountCatalog `json:"serviceAccount"`
	PublishRules          PublishRules          `json:"publishRules"`
	ClusterRoles          bool                  `json:"clusterRoles"`
}

// Catalog returns documented engine constraints. No cluster is contacted.
func Catalog() EngineCatalog {
	return EngineCatalog{
		CredentialType:        CredentialType,
		CredentialSecretField: CredentialSecretField,
		AllowedKinds:          append([]string(nil), AllowedKinds...),
		AllowedVerbs:          append([]string(nil), AllowedVerbs...),
		EvaluationKeys:        EvaluationKeys(),
		ClusterRoles:          false,
		ServiceAccount: ServiceAccountCatalog{
			DefaultName:        DefaultServiceAccountName,
			RoleTemplate:       RoleTemplateNamespaceRunner,
			RoleTemplatePath:   RoleTemplatePath,
			RoleBindingPath:    RoleBindingTemplatePath,
			ServiceAccountPath: ServiceAccountPath,
			ClusterRoles:       false,
			Notes:              "Apply the namespace-scoped Role and RoleBinding templates in each allowed namespace. ClusterRoles are not MVP. Workers receive only this metadata plus an ephemeral kubeconfig handle.",
		},
		PublishRules: PublishRules{
			ClusterTargetRequired:      []string{"credentialId", "endpoint"},
			KubernetesPolicyRequired:   []string{"allowedNamespaces|namespaces"},
			EmptyAllowlistsRejected:    true,
			CredentialType:             CredentialType,
			DenyAllowsMissingAllowlist: true,
		},
	}
}
