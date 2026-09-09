package workflow

import "github.com/bbengt1/flowforge/apps/api/internal/scripts"

func scriptBounds() *NodeBounds {
	return &NodeBounds{
		MaxInputBytes:       MaxPortBytes,
		MaxOutputBytes:      MaxPortBytes,
		MaxWithBytes:        MaxScalarBytes,
		MaxAggregationItems: MaxAggregationItems,
		MaxDurationSeconds:  scripts.MaxTimeoutSeconds,
	}
}

func scriptPythonContract() NodeType {
	return scriptNodeContract(scripts.NodePython, scripts.LanguagePython, "Run Python script",
		"Run published signed Python source in an isolated runner. Execution uses the pinned digest and digest-locked image, not draft source.")
}

func scriptGoContract() NodeType {
	return scriptNodeContract(scripts.NodeGo, scripts.LanguageGo, "Run Go script",
		"Run a precompiled signed Go binary built from the published source. Isolation gates apply before the controlled builder.")
}

func scriptNodeContract(typ, _, title, description string) NodeType {
	return NodeType{
		Type:        typ,
		Phase:       PhaseCore,
		Title:       title,
		Description: description,
		Inputs: []Port{
			{Name: "input", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Validated JSON input. Typed enforcement is E9.3."},
		},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Redacted result. Never includes secret handles."},
		},
		RequiredWith: []string{"source", "entrypoint", "runtimeProfileId", "timeoutSeconds"},
		AllowedWith:  scriptWithFields(),
		Policy: &NodePolicy{
			Permissions:        scripts.RequiredPermissions(),
			RetrySafe:          false,
			SideEffects:        true,
			Idempotent:         false,
			Cancellation:       "abort-process",
			Verification:       "E9.2-isolated-runner",
			DefaultMaxAttempts: 0,
		},
		Bounds: scriptBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"runtimeProfileId", "entrypoint", "artifactDigest", "scanStatus", "language", "correlationId"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func scriptWithFields() []WithField {
	return []WithField{
		{Name: "source", Kind: "string", Required: true, Description: "Approved source. Secrets are rejected. Publish packages this into a signed digest."},
		{Name: "entrypoint", Kind: "string", Required: true, Description: "Basename only. Python: main.py. Go: main.go or package.Function."},
		{Name: "runtimeProfileId", Kind: "uuid", Required: true, Description: "Published runtime profile UUID. Workflow publish pins the exact revision."},
		{Name: "timeoutSeconds", Kind: "integer", Required: true, Description: "Bounded 1–3600."},
		{Name: "memoryMiB", Kind: "integer", Description: "Bounded 32–2048."},
		{Name: "cpuMillis", Kind: "integer", Description: "Optional CPU millicores."},
		{Name: "processes", Kind: "integer", Description: "Optional process cap."},
		{Name: "inputSchema", Kind: "object", Description: "Declared input JSON Schema subset. Shape validated at publish; typed I/O is E9.3."},
		{Name: "outputSchema", Kind: "object", Description: "Declared output JSON Schema subset. Shape validated at publish; typed I/O is E9.3."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published kind=script policy UUID."},
	}
}
