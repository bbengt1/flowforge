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

// NodeField is an allowlisted with key for Chloe's library/wizard.
type NodeField struct {
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	Required    bool     `json:"required"`
	Enum        []string `json:"enum,omitempty"`
	Description string   `json:"description"`
}

// NodeContract is the E7.2 apply/get/list catalog entry.
type NodeContract struct {
	Type               string      `json:"type"`
	Verb               string      `json:"verb"`
	Title              string      `json:"title"`
	Description        string      `json:"description"`
	Permissions        []string    `json:"permissions"`
	RequiredWith       []string    `json:"requiredWith"`
	AllowedWith        []NodeField `json:"allowedWith"`
	Outputs            []string    `json:"outputs"`
	SideEffects        bool        `json:"sideEffects"`
	RetrySafe          bool        `json:"retrySafe"`
	Idempotent         bool        `json:"idempotent"`
	FieldManager       string      `json:"fieldManager,omitempty"`
	Force              *bool       `json:"force,omitempty"`
	ServerDryRunAlways bool        `json:"serverDryRunAlways,omitempty"`
	WaitReady          string      `json:"waitReady,omitempty"`
}

// ErrorShape documents engine failures for Chloe.
type ErrorShape struct {
	Code    string `json:"code"`
	Status  int    `json:"status"`
	Meaning string `json:"meaning"`
}

// ApplyRules documents the fixed SSA contract.
type ApplyRules struct {
	FieldManager       string `json:"fieldManager"`
	Force              bool   `json:"force"`
	ServerDryRunAlways bool   `json:"serverDryRunAlways"`
	ClientDryRunExtra  bool   `json:"clientDryRunAddsLocalValidationOnly"`
	WaitReady          string `json:"waitReady"`
}

// ObservationRules documents bounded rollout watch for Chloe.
type ObservationRules struct {
	WaitReady    string   `json:"waitReady"`
	States       []string `json:"states"`
	Kinds        []string `json:"kinds"`
	Verb         string   `json:"verb"`
	Cancel       string   `json:"cancel"`
	Timeout      string   `json:"timeout"`
	NeverMutates bool     `json:"neverDeletesOrRollsBack"`
}

// EngineCatalog is the Chloe / worker vocabulary for E7.1–E7.3.
type EngineCatalog struct {
	CredentialType        string                `json:"credentialType"`
	CredentialSecretField string                `json:"credentialSecretField"`
	AllowedKinds          []string              `json:"allowedKinds"`
	AllowedVerbs          []string              `json:"allowedVerbs"`
	EvaluationKeys        []EvaluationKey       `json:"evaluationKeys"`
	ServiceAccount        ServiceAccountCatalog `json:"serviceAccount"`
	PublishRules          PublishRules          `json:"publishRules"`
	ClusterRoles          bool                  `json:"clusterRoles"`
	Nodes                 []NodeContract        `json:"nodes"`
	Errors                []ErrorShape          `json:"errors"`
	Apply                 ApplyRules            `json:"apply"`
	Observation           ObservationRules      `json:"observation"`
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
		Nodes:  NodeContracts(),
		Errors: ErrorCatalog(),
		Apply: ApplyRules{
			FieldManager:       FieldManager,
			Force:              false,
			ServerDryRunAlways: true,
			ClientDryRunExtra:  true,
			WaitReady:          WaitReadyObserved,
		},
		Observation: ObservationRules{
			WaitReady:    WaitReadyObserved,
			States:       []string{ObservationReady, ObservationFailed, ObservationTimeout, ObservationCanceled, ObservationSkipped, ObservationProgressing},
			Kinds:        append([]string(nil), ObservableKinds...),
			Verb:         "watch",
			Cancel:       "stop-wait",
			Timeout:      "stop-wait",
			NeverMutates: true,
		},
	}
}

func commonNodeFields(extra ...NodeField) []NodeField {
	base := []NodeField{
		{Name: "clusterTargetId", Kind: "uuid", Required: true, Description: "Published cluster target UUID. YAML stores only the resource id."},
		{Name: "namespace", Kind: "string", Required: true, Description: "DNS-1123 namespace. Must be on the target and policy allowlists."},
		{Name: "dryRun", Kind: "enum", Enum: []string{"client", "server"}, Description: "client adds local validation only. Apply always performs strict server-side dry-run before persist."},
		{Name: "wait", Kind: "enum", Enum: []string{"none", "ready"}, Description: "none returns after apply. ready performs a bounded Deployment/StatefulSet/DaemonSet/Job watch. Cancel and timeout stop waiting; they never delete or roll back."},
		{Name: "timeoutSeconds", Kind: "integer", Description: "Bounded 1–3600. Default 60."},
		{Name: "fieldManager", Kind: "enum", Enum: []string{FieldManager}, Description: "Service-owned. Must be flowforge when set."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published kubernetes policy UUID."},
	}
	return append(base, extra...)
}

// NodeContracts is the Chloe wizard map for apply/get/list/rolloutStatus.
func NodeContracts() []NodeContract {
	force := false
	return []NodeContract{
		{
			Type: "kubernetes.apply", Verb: "apply", Title: "Apply manifests",
			Description:  "Parse and validate YAML, revalidate policy, strict server-side dry-run, then server-side apply. Ownership conflicts are returned; Force is never true.",
			Permissions:  RequiredPermissions("apply"),
			RequiredWith: []string{"clusterTargetId", "namespace"},
			AllowedWith:  commonNodeFields(NodeField{Name: "manifests", Kind: "string", Description: "Multi-document YAML. Secret data is denied. Images must be allowlisted and digest-pinned."}),
			Outputs:      []string{"result", "resources", "status"},
			SideEffects:  true, RetrySafe: false, Idempotent: true,
			FieldManager: FieldManager, Force: &force, ServerDryRunAlways: true, WaitReady: WaitReadyObserved,
		},
		{
			Type: "kubernetes.get", Verb: "get", Title: "Get resource",
			Description:  "Read one allowlisted resource in an allowlisted namespace.",
			Permissions:  RequiredPermissions("get"),
			RequiredWith: []string{"clusterTargetId", "namespace", "kind", "name"},
			AllowedWith: commonNodeFields(
				NodeField{Name: "kind", Kind: "enum", Required: true, Enum: append([]string(nil), AllowedKinds...), Description: "Allowlisted kind only."},
				NodeField{Name: "name", Kind: "string", Required: true, Description: "Resource name."},
			),
			Outputs:     []string{"result", "items"},
			SideEffects: false, RetrySafe: true, Idempotent: true,
		},
		{
			Type: "kubernetes.list", Verb: "list", Title: "List resources",
			Description:  "List allowlisted resources in an allowlisted namespace.",
			Permissions:  RequiredPermissions("list"),
			RequiredWith: []string{"clusterTargetId", "namespace", "kind"},
			AllowedWith: commonNodeFields(
				NodeField{Name: "kind", Kind: "enum", Required: true, Enum: append([]string(nil), AllowedKinds...), Description: "Allowlisted kind only."},
			),
			Outputs:     []string{"result", "items"},
			SideEffects: false, RetrySafe: true, Idempotent: true,
		},
		{
			Type: "kubernetes.rolloutStatus", Verb: "watch", Title: "Rollout status",
			Description:  "Bounded watch of Deployment, StatefulSet, DaemonSet, or Job. Timeout or cancel stops waiting and never deletes or rolls back resources.",
			Permissions:  RequiredPermissions("watch"),
			RequiredWith: []string{"clusterTargetId", "namespace"},
			AllowedWith: commonNodeFields(
				NodeField{Name: "kind", Kind: "enum", Enum: append([]string(nil), ObservableKinds...), Description: "Deployment, StatefulSet, DaemonSet, or Job."},
				NodeField{Name: "name", Kind: "string", Description: "Resource name. Required unless resource input supplies it."},
				NodeField{Name: "resource", Kind: "object", Description: "Optional {kind,name} identity. Alternative to with.kind and with.name."},
			),
			Outputs:     []string{"result", "status"},
			SideEffects: false, RetrySafe: true, Idempotent: true,
			WaitReady: WaitReadyObserved,
		},
	}
}

// ErrorCatalog is the RFC 9457-aligned engine error map.
func ErrorCatalog() []ErrorShape {
	return []ErrorShape{
		{Code: CodeInvalidManifest, Status: 400, Meaning: "YAML could not be parsed or a required field is missing."},
		{Code: CodeSecretForbidden, Status: 400, Meaning: "Secret kind or secret data/stringData/binaryData was submitted."},
		{Code: CodeKindDenied, Status: 403, Meaning: "Kind is not on the engine or policy allowlist (includes CRDs, RBAC, webhooks, cluster-scoped)."},
		{Code: CodeNamespaceDenied, Status: 403, Meaning: "Namespace is missing, mismatched, or not allowlisted."},
		{Code: CodeVerbDenied, Status: 403, Meaning: "Verb is not on the engine or policy allowlist."},
		{Code: CodePolicyDenied, Status: 403, Meaning: "Target/policy deny or allowlist failed closed."},
		{Code: CodePermissionDenied, Status: 403, Meaning: "Missing workflow.execute, kubernetes.apply|read, or clusterTarget.use."},
		{Code: CodeRBACDenied, Status: 403, Meaning: "Kubernetes RBAC denied the request."},
		{Code: CodeImageDenied, Status: 403, Meaning: "Image is not allowlisted or not digest-pinned."},
		{Code: CodeIngressDenied, Status: 403, Meaning: "Ingress host, TLS, backend, or annotation failed policy."},
		{Code: CodeWorkloadDenied, Status: 403, Meaning: "Privileged, host namespaces, hostPath, or capability escalation."},
		{Code: CodeOwnershipConflict, Status: 409, Meaning: "SSA field-manager conflict. Force is never applied."},
		{Code: CodeDryRunFailed, Status: 400, Meaning: "Strict server-side dry-run rejected the manifest."},
		{Code: CodeApplyFailed, Status: 502, Meaning: "Persistent apply failed after a successful dry-run."},
		{Code: CodeReadFailed, Status: 404, Meaning: "Get/list did not return the requested namespaced object."},
		{Code: CodeHandleForbidden, Status: 403, Meaning: "Credential handle missing, expired, or contained an unsafe kubeconfig."},
		{Code: CodeTimeout, Status: 408, Meaning: "Bounded timeoutSeconds elapsed. Resources are left in place."},
		{Code: CodeCanceled, Status: 408, Meaning: "Observation was canceled. Resources are not deleted or rolled back."},
		{Code: CodeRolloutFailed, Status: 409, Meaning: "Deployment progress deadline exceeded or Job failed. Resources are not deleted or rolled back."},
	}
}
