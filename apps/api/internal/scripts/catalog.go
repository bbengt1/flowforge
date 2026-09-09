package scripts

// PublishRules documents fail-closed publish/pin constraints for Chloe.
type PublishRules struct {
	RequiredWith             []string `json:"requiredWith"`
	AllowedLanguages         []string `json:"allowedLanguages"`
	SourceVisibleInYAML      bool     `json:"sourceVisibleInYAML"`
	SecretsForbiddenInYAML   bool     `json:"secretsForbiddenInYAML"`
	DraftsCannotExecute      bool     `json:"draftsCannotExecute"`
	MutableArtifactsRejected bool     `json:"mutableArtifactsRejected"`
	UnscannedRejected        bool     `json:"unscannedRejected"`
	UnsignedRejected         bool     `json:"unsignedRejected"`
	FailedScanRejected       bool     `json:"failedScanRejected"`
	PublishedRevisionsPinned bool     `json:"publishedRevisionsPinned"`
	DigestPinnedRuntime      bool     `json:"digestPinnedRuntime"`
	MaxSourceBytes           int      `json:"maxSourceBytes"`
	MaxTimeoutSeconds        int      `json:"maxTimeoutSeconds"`
}

// IsolationRules documents E9.2 runner guarantees for Chloe and workers.
type IsolationRules struct {
	NonRoot                  bool                   `json:"nonRoot"`
	ReadOnlyRootFS           bool                   `json:"readOnlyRootFS"`
	DroppedCapabilities      bool                   `json:"droppedCapabilities"`
	NoNewPrivs               bool                   `json:"noNewPrivs"`
	NoMetadataService        bool                   `json:"noMetadataService"`
	NoHostDockerSocket       bool                   `json:"noHostDockerSocket"`
	RuntimePackageInstall    bool                   `json:"runtimePackageInstall"`
	ApprovedImagesOnly       bool                   `json:"approvedImagesOnly"`
	UID                      int                    `json:"uid"`
	GID                      int                    `json:"gid"`
	EphemeralWorkspace       string                 `json:"ephemeralWorkspace"`
	DropCapabilityNames      []string               `json:"dropCapabilityNames"`
	AllowPrivilegeEscalation bool                   `json:"allowPrivilegeEscalation"`
	NoServiceAccountMount    bool                   `json:"noServiceAccountMount"`
	DefaultDenyEgress        bool                   `json:"defaultDenyEgress"`
	DNSConstrained           bool                   `json:"dnsConstrained"`
	MetadataCIDRs            []string               `json:"metadataCIDRs"`
	RuntimeProfile           RuntimeProfileContract `json:"runtimeProfile"`
	CIHarness                string                 `json:"ciHarness"`
	KubernetesManifests      []string               `json:"kubernetesManifests"`
	Note                     string                 `json:"note"`
	Hooks                    []string               `json:"hooks"`
}

// RuntimeProfileContract is the pinned ops-config shape the runner consumes.
type RuntimeProfileContract struct {
	Language             string   `json:"language"`
	ImageDigest          string   `json:"imageDigest"`
	DependencyLockDigest string   `json:"dependencyLockDigest"`
	Limits               []string `json:"limits"`
	Egress               string   `json:"egress"`
	MutableTagsRejected  bool     `json:"mutableTagsRejected"`
}

// NodeField is an allowlisted with key for Chloe's library/wizard.
type NodeField struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Required    bool   `json:"required"`
	Description string `json:"description"`
}

// NodeContract is the script.* catalog entry (runner is E9.2).
type NodeContract struct {
	Type         string      `json:"type"`
	Language     string      `json:"language"`
	Title        string      `json:"title"`
	Description  string      `json:"description"`
	Permissions  []string    `json:"permissions"`
	RequiredWith []string    `json:"requiredWith"`
	AllowedWith  []NodeField `json:"allowedWith"`
	Outputs      []string    `json:"outputs"`
	SideEffects  bool        `json:"sideEffects"`
	RetrySafe    bool        `json:"retrySafe"`
	Idempotent   bool        `json:"idempotent"`
}

// ErrorShape documents control-plane failures for Chloe.
type ErrorShape struct {
	Code    string `json:"code"`
	Status  int    `json:"status"`
	Meaning string `json:"meaning"`
}

// EngineCatalog is the Chloe / worker vocabulary for E9.1–E9.4.
type EngineCatalog struct {
	Languages    []string          `json:"languages"`
	PublishRules PublishRules      `json:"publishRules"`
	Nodes        []NodeContract    `json:"nodes"`
	Errors       []ErrorShape      `json:"errors"`
	Permissions  []string          `json:"permissions"`
	Isolation    IsolationRules    `json:"isolation"`
	Hooks        map[string]string `json:"hooks"`
}

// Catalog returns documented engine constraints. No runner is started.
func Catalog() EngineCatalog {
	return EngineCatalog{
		Languages:   []string{LanguagePython, LanguageGo},
		Permissions: RequiredPermissions(),
		PublishRules: PublishRules{
			RequiredWith:             []string{"source", "entrypoint", "runtimeProfileId", "timeoutSeconds"},
			AllowedLanguages:         []string{LanguagePython, LanguageGo},
			SourceVisibleInYAML:      true,
			SecretsForbiddenInYAML:   true,
			DraftsCannotExecute:      true,
			MutableArtifactsRejected: true,
			UnscannedRejected:        true,
			UnsignedRejected:         true,
			FailedScanRejected:       true,
			PublishedRevisionsPinned: true,
			DigestPinnedRuntime:      true,
			MaxSourceBytes:           MaxSourceBytes,
			MaxTimeoutSeconds:        MaxTimeoutSeconds,
		},
		Isolation: IsolationRules{
			NonRoot:                  true,
			ReadOnlyRootFS:           true,
			DroppedCapabilities:      true,
			NoNewPrivs:               true,
			NoMetadataService:        true,
			NoHostDockerSocket:       true,
			RuntimePackageInstall:    false,
			ApprovedImagesOnly:       true,
			UID:                      RunnerUID,
			GID:                      RunnerGID,
			EphemeralWorkspace:       RunnerWorkspacePath,
			DropCapabilityNames:      []string{CapabilityDropAll},
			AllowPrivilegeEscalation: false,
			NoServiceAccountMount:    true,
			DefaultDenyEgress:        true,
			DNSConstrained:           true,
			MetadataCIDRs:            MetadataCIDRs(),
			RuntimeProfile: RuntimeProfileContract{
				Language:             "python|go",
				ImageDigest:          "sha256:<64 hex>",
				DependencyLockDigest: "sha256:<64 hex>",
				Limits:               []string{"cpuMillis", "memoryMib", "timeoutSeconds", "processes"},
				Egress:               "optional {destinations:[{host,port,protocol}], dnsConstrained:true}; omitted is default-deny",
				MutableTagsRejected:  true,
			},
			CIHarness: "apps/api/internal/scripts HarnessRuntime — enforces UID/FS/caps/no_new_privs/metadata/egress/limits/package-install without starting a container. Full runc/containerd is not required in CI.",
			KubernetesManifests: []string{
				"deploy/kubernetes/script-runner-deployment.yaml",
				"deploy/kubernetes/script-runner-networkpolicy.yaml",
			},
			Note:  "E9.2 isolated runner. Execute calls VerifyForDispatch, then HarnessRuntime (CI) or a live Kubernetes Job. Python uses the pinned image+lock; Go uses a controlled-builder signed binary (CI stub still enforces isolation).",
			Hooks: []string{"VerifyForDispatch", "Execute", "IsolationSpec"},
		},
		Hooks: map[string]string{
			"E9.2": "isolated runner (VerifyForDispatch then Execute)",
			"E9.3": "typed I/O + scoped handles + output redaction + lease-loss recovery",
			"E9.4": "artifact revocation + emergency stop",
		},
		Nodes:  NodeContracts(),
		Errors: ErrorCatalog(),
	}
}

// NodeContracts is the Chloe wizard map for script.python / script.go.
func NodeContracts() []NodeContract {
	fields := []NodeField{
		{Name: "source", Kind: "string", Required: true, Description: "Approved Python or Go source. Versioned with the workflow YAML. Secrets are rejected."},
		{Name: "entrypoint", Kind: "string", Required: true, Description: "Basename only. Python: main.py. Go: main.go or package.Function."},
		{Name: "runtimeProfileId", Kind: "uuid", Required: true, Description: "Published runtime profile UUID. Workflow publish pins the exact revision (digest-pinned image + lockfile)."},
		{Name: "timeoutSeconds", Kind: "integer", Required: true, Description: "Bounded 1–3600."},
		{Name: "memoryMiB", Kind: "integer", Description: "Bounded 32–2048. Must not exceed the pinned runtime profile."},
		{Name: "cpuMillis", Kind: "integer", Description: "Optional CPU millicores. Must not exceed the pinned runtime profile."},
		{Name: "processes", Kind: "integer", Description: "Optional process cap. Must not exceed the pinned runtime profile."},
		{Name: "inputSchema", Kind: "object", Description: "Declared input JSON Schema subset. Shape is validated at publish; typed execution is E9.3."},
		{Name: "outputSchema", Kind: "object", Description: "Declared output JSON Schema subset. Shape is validated at publish; typed execution is E9.3."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published kind=script policy UUID."},
	}
	return []NodeContract{
		{
			Type: NodePython, Language: LanguagePython, Title: "Run Python script",
			Description:  "Run published signed Python source in an isolated runner (non-root, read-only rootfs, dropped caps, no_new_privs, default-deny egress). Uses the pinned digest-locked image, not draft source.",
			Permissions:  RequiredPermissions(),
			RequiredWith: []string{"source", "entrypoint", "runtimeProfileId", "timeoutSeconds"},
			AllowedWith:  fields,
			Outputs:      []string{"result"},
			SideEffects:  true, RetrySafe: false, Idempotent: false,
		},
		{
			Type: NodeGo, Language: LanguageGo, Title: "Run Go script",
			Description:  "Run a precompiled signed Go binary built from the published source in a controlled builder (CI uses a documented stub that still enforces isolation).",
			Permissions:  RequiredPermissions(),
			RequiredWith: []string{"source", "entrypoint", "runtimeProfileId", "timeoutSeconds"},
			AllowedWith:  fields,
			Outputs:      []string{"result"},
			SideEffects:  true, RetrySafe: false, Idempotent: false,
		},
	}
}

// ErrorCatalog is the RFC 9457-aligned engine error map.
func ErrorCatalog() []ErrorShape {
	return []ErrorShape{
		{Code: CodeInvalidSource, Status: 400, Meaning: "Source is missing, not UTF-8, the wrong language shape, or exceeds 64 KiB."},
		{Code: CodeInvalidEntrypoint, Status: 400, Meaning: "Entrypoint is empty, a path, or does not match the language (main.py / main.go)."},
		{Code: CodeInvalidRuntimeProfile, Status: 400, Meaning: "Runtime profile is missing, unpublished, or not digest-pinned."},
		{Code: CodeLanguageMismatch, Status: 400, Meaning: "script.python must pin a python profile; script.go must pin a go profile."},
		{Code: CodeInvalidSchema, Status: 400, Meaning: "inputSchema or outputSchema is not the documented JSON Schema subset."},
		{Code: CodeSecretForbidden, Status: 400, Meaning: "Source or YAML contained secret material (PEM, kubeconfig, tokens)."},
		{Code: CodeSizeLimit, Status: 400, Meaning: "Source, timeout, or resource limit exceeded the documented cap."},
		{Code: CodeArtifactMutable, Status: 400, Meaning: "A draft or unsigned package cannot be executed. Publish first."},
		{Code: CodeArtifactUnscanned, Status: 400, Meaning: "Artifact scan_status is pending or missing."},
		{Code: CodeArtifactUnsigned, Status: 400, Meaning: "Artifact signature is missing or does not verify."},
		{Code: CodeArtifactScanFailed, Status: 400, Meaning: "Artifact scan_status is failed."},
		{Code: CodeArtifactRevoked, Status: 409, Meaning: "E9.4: revoked artifacts cannot start. Hook only in E9.1."},
		{Code: CodePermissionDenied, Status: 403, Meaning: "Missing workflow.execute, script.run, or runtimeProfile.use."},
		{Code: CodePolicyDenied, Status: 403, Meaning: "kind=script policy deny."},
		{Code: CodeIsolationDenied, Status: 403, Meaning: "Requested runner environment violates isolation (UID, FS, caps, mounts)."},
		{Code: CodeRootDenied, Status: 403, Meaning: "Runner UID/GID must be non-root (65532)."},
		{Code: CodeWritableRootFSDenied, Status: 403, Meaning: "Root filesystem is read-only; only /workspace is writable."},
		{Code: CodeCapabilityDenied, Status: 403, Meaning: "All Linux capabilities are dropped."},
		{Code: CodePrivilegeEscalation, Status: 403, Meaning: "no_new_privs is required; privilege escalation is denied."},
		{Code: CodeMetadataDenied, Status: 403, Meaning: "Cloud instance metadata (169.254.169.254 and equivalents) is denied."},
		{Code: CodeEgressDenied, Status: 403, Meaning: "Destination is outside the default-deny egress allowlist, or DNS is unconstrained."},
		{Code: CodePackageInstallDenied, Status: 403, Meaning: "Runtime package installation (pip, go get, apt, …) is denied."},
		{Code: CodeImageDenied, Status: 400, Meaning: "Arbitrary or mutable base images are denied. imageDigest must be sha256:<hex>."},
		{Code: CodeDockerSocketDenied, Status: 403, Meaning: "Host Docker socket is denied."},
		{Code: CodeServiceAccountDenied, Status: 403, Meaning: "Kubernetes service-account mounts are denied (MVP)."},
		{Code: CodeResourceLimit, Status: 400, Meaning: "CPU, memory, process, or time limit exceeded the pinned runtime profile."},
		{Code: CodeIndeterminate, Status: 409, Meaning: "Lease lost after dispatch. The script is not retried (E9.3 recovery hook)."},
		{Code: CodeRunnerNotImplemented, Status: 501, Meaning: "Live container runtime requested (RequireLiveRuntime) but only the CI harness is available."},
		{Code: CodeIONotImplemented, Status: 501, Meaning: "E9.3 typed I/O execution is not enabled."},
		{Code: CodeRevocationNotImplemented, Status: 501, Meaning: "E9.4 revocation API is not enabled."},
	}
}
