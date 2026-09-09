package workflow

import "github.com/bbengt1/flowforge/apps/api/internal/kubernetes"

func kubernetesBounds() *NodeBounds {
	return &NodeBounds{
		MaxInputBytes:       kubernetes.MaxManifestBytes,
		MaxOutputBytes:      MaxPortBytes,
		MaxWithBytes:        kubernetes.MaxManifestBytes,
		MaxAggregationItems: MaxAggregationItems,
		MaxDurationSeconds:  kubernetes.MaxTimeoutSeconds,
	}
}

func kubernetesApplyContract() NodeType {
	return NodeType{
		Type:        "kubernetes.apply",
		Phase:       PhaseCore,
		Title:       "Apply manifests",
		Description: "Validate YAML and policy, always server-side dry-run, then server-side apply with FieldManager=flowforge and Force=false.",
		Inputs: []Port{
			{Name: "manifests", Kind: PortString, Classification: ClassInternal, MaxBytes: kubernetes.MaxManifestBytes, Description: "Optional wired manifests. with.manifests is also accepted."},
			{Name: "parameters", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Optional typed parameters. Not interpolated into manifests."},
		},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Redacted apply summary."},
			{Name: "resources", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Applied resource identities."},
			{Name: "status", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Observed generation/state. wait=ready is deferred to E7.3."},
		},
		RequiredWith: []string{"clusterTargetId", "namespace"},
		AllowedWith:  kubernetesWithFields(true, false, false),
		Policy: &NodePolicy{
			Permissions:        kubernetes.RequiredPermissions("apply"),
			RetrySafe:          false,
			SideEffects:        true,
			Idempotent:         true,
			Cancellation:       "stop-wait",
			Verification:       "observe-generation",
			DefaultMaxAttempts: 1,
		},
		Bounds: kubernetesBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"clusterTargetId", "namespace", "manifestDigest", "fieldManager", "force", "dryRun", "applied"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func kubernetesGetContract() NodeType {
	return NodeType{
		Type:        "kubernetes.get",
		Phase:       PhaseCore,
		Title:       "Get resource",
		Description: "Read one allowlisted resource in an allowlisted namespace.",
		Inputs:      []Port{{Name: "parameters", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes}},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Redacted resource summary."},
			{Name: "items", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Single-item list of the redacted object."},
		},
		RequiredWith: []string{"clusterTargetId", "namespace", "kind", "name"},
		AllowedWith:  kubernetesWithFields(false, true, true),
		Policy: &NodePolicy{
			Permissions:        kubernetes.RequiredPermissions("get"),
			RetrySafe:          true,
			SideEffects:        false,
			Idempotent:         true,
			Cancellation:       "path-local",
			Verification:       "none",
			DefaultMaxAttempts: 1,
		},
		Bounds: kubernetesBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"clusterTargetId", "namespace", "kind", "name"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func kubernetesListContract() NodeType {
	return NodeType{
		Type:        "kubernetes.list",
		Phase:       PhaseCore,
		Title:       "List resources",
		Description: "List allowlisted resources in an allowlisted namespace.",
		Inputs:      []Port{{Name: "parameters", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes}},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Redacted list summary."},
			{Name: "items", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Redacted objects in the node namespace only."},
		},
		RequiredWith: []string{"clusterTargetId", "namespace", "kind"},
		AllowedWith:  kubernetesWithFields(false, true, false),
		Policy: &NodePolicy{
			Permissions:        kubernetes.RequiredPermissions("list"),
			RetrySafe:          true,
			SideEffects:        false,
			Idempotent:         true,
			Cancellation:       "path-local",
			Verification:       "none",
			DefaultMaxAttempts: 1,
		},
		Bounds: kubernetesBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"clusterTargetId", "namespace", "kind", "count"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func kubernetesWithFields(manifests, kind, name bool) []WithField {
	fields := []WithField{
		{Name: "clusterTargetId", Kind: "uuid", Required: true, Description: "Published cluster target UUID."},
		{Name: "namespace", Kind: "string", Required: true, Description: "DNS-1123 namespace. Must match the target and policy allowlists."},
		{Name: "dryRun", Kind: "enum", Enum: []string{"client", "server"}, Description: "client adds local validation only and never replaces server-side dry-run on apply."},
		{Name: "wait", Kind: "enum", Enum: []string{"none", "ready"}, Description: "ready is accepted; bounded rollout watch is E7.3."},
		{Name: "timeoutSeconds", Kind: "integer", Description: "Bounded 1–3600."},
		{Name: "fieldManager", Kind: "enum", Enum: []string{kubernetes.FieldManager}, Description: "Service-owned. Must be flowforge when set."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published kubernetes policy UUID."},
	}
	if manifests {
		fields = append(fields, WithField{Name: "manifests", Kind: "string", Description: "Multi-document YAML. Secret data is denied."})
	}
	if kind {
		fields = append(fields, WithField{Name: "kind", Kind: "enum", Required: true, Enum: append([]string(nil), kubernetes.AllowedKinds...), Description: "Allowlisted kind only."})
	}
	if name {
		fields = append(fields, WithField{Name: "name", Kind: "string", Required: true, Description: "Resource name."})
	}
	return fields
}
