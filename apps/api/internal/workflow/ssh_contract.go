package workflow

import "github.com/bbengt1/flowforge/apps/api/internal/ssh"

func sshBounds() *NodeBounds {
	return &NodeBounds{
		MaxInputBytes:       MaxPortBytes,
		MaxOutputBytes:      MaxPortBytes,
		MaxWithBytes:        MaxPortBytes,
		MaxAggregationItems: MaxAggregationItems,
		MaxDurationSeconds:  ssh.MaxTimeoutSeconds,
	}
}

func sshRunContract() NodeType {
	return NodeType{
		Type:        ssh.NodeSSHRun,
		Phase:       PhaseCore,
		Title:       "Run command profile",
		Description: "Run an approved command profile on a pinned SSH target. Uses an ephemeral key handle, verified known hosts, DNS/address allowlists, key-only auth, and a bounded non-interactive command.",
		Inputs: []Port{
			{Name: "parameters", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Optional typed parameters matching the pinned profile schema. Quoted by the reviewed renderer."},
		},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Redacted run summary (exit, addresses, audit). Never includes privateKey."},
			{Name: "stdout", Kind: PortString, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Bounded, redacted command stdout."},
			{Name: "exitCode", Kind: PortInteger, Classification: ClassPublic, MaxBytes: 8, Description: "Remote process exit code."},
		},
		RequiredWith: []string{"sshTargetId", "commandProfileId"},
		AllowedWith:  sshWithFields(),
		Policy: &NodePolicy{
			Permissions:        ssh.RequiredPermissions(),
			RetrySafe:          false,
			SideEffects:        true,
			Idempotent:         false,
			Cancellation:       "abort-command",
			Verification:       "e8.3-stub",
			DefaultMaxAttempts: ssh.DefaultMaxAttempts,
		},
		Bounds: sshBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"sshTargetId", "commandProfileId", "parameterNames", "exitCode", "connectedAddress", "correlationId"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func sshWithFields() []WithField {
	return []WithField{
		{Name: "sshTargetId", Kind: "uuid", Required: true, Description: "Published SSH target UUID. YAML stores only the resource id."},
		{Name: "commandProfileId", Kind: "uuid", Required: true, Description: "Published command profile UUID. Workflow publish pins the exact revision."},
		{Name: "parameters", Kind: "object", Description: "Values matching the pinned profile parameterSchema. Rejected when outside the schema."},
		{Name: "timeoutSeconds", Kind: "integer", Description: "Bounded 1–3600. Default 60. Applies to connect and command."},
		{Name: "retryPolicy", Kind: "object", Description: "Required explicit field shape {maxAttempts:0-5}. Default maxAttempts is 0. E8.2 never blindly re-runs; E8.3 adds verification."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published ssh policy UUID."},
	}
}
