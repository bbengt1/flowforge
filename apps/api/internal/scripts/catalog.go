package scripts

import "github.com/bbengt1/flowforge/apps/api/internal/authz"

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
	RevokedRejected          bool     `json:"revokedRejected"`
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

// IORules documents typed input/output + handle injection for Chloe.
type IORules struct {
	MaxInputBytes        int      `json:"maxInputBytes"`
	MaxOutputBytes       int      `json:"maxOutputBytes"`
	SecretsForbidden     bool     `json:"secretsForbidden"`
	PlaintextCredentials bool     `json:"plaintextCredentials"`
	HandleInjection      string   `json:"handleInjection"`
	HandleTTLSeconds     int      `json:"handleTTLSeconds"`
	HandleMaxTTLSeconds  int      `json:"handleMaxTTLSeconds"`
	AllowlistedEnv       []string `json:"allowlistedEnv"`
	ForbiddenEnv         []string `json:"forbiddenEnv"`
	ValidateBeforeInject bool     `json:"validateBeforeInject"`
	RedactBeforePersist  bool     `json:"redactBeforePersist"`
	Note                 string   `json:"note"`
}

// RetryRules documents default-zero retries and the verification contract.
type RetryRules struct {
	DefaultMaxAttempts                int               `json:"defaultMaxAttempts"`
	MaxAttempts                       int               `json:"maxAttempts"`
	RetrySafeFlag                     string            `json:"retrySafeFlag"`
	IdempotencyKey                    string            `json:"idempotencyKey"`
	Semantics                         string            `json:"semantics"`
	Note                              string            `json:"note"`
	BlindRetry                        bool              `json:"blindRetry"`
	LeaseLossOutcome                  string            `json:"leaseLossOutcome"`
	UnknownOutcome                    string            `json:"unknownOutcome"`
	RequiresIdempotencyKey            bool              `json:"requiresIdempotencyKey"`
	RequiresVerificationWhenRetrySafe bool              `json:"requiresVerificationWhenRetrySafe"`
	Verification                      string            `json:"verification"`
	WhenRetryAllowed                  string            `json:"whenRetryAllowed"`
	States                            []string          `json:"states"`
	UI                                RetryUI           `json:"ui"`
	Probe                             VerificationRules `json:"probe"`
}

// VerificationRules documents the node-declared idempotent hook.
type VerificationRules struct {
	RequiredWhenRetrySafe bool     `json:"requiredWhenRetrySafe"`
	Field                 string   `json:"field"`
	Behavior              string   `json:"behavior"`
	OnMatchDefault        string   `json:"onMatchDefault"`
	OnMismatchDefault     string   `json:"onMismatchDefault"`
	OnError               string   `json:"onError"`
	Outcomes              []string `json:"outcomes"`
	Note                  string   `json:"note"`
}

// RetryUI is the Chloe contract for badges and retry controls.
type RetryUI struct {
	IndeterminateBadge string `json:"indeterminateBadge"`
	RetrySafeFlag      string `json:"retrySafeFlag"`
	RetryEnabledWhen   string `json:"retryEnabledWhen"`
	HideRetryWhen      string `json:"hideRetryWhen"`
	NeverAssumeAbsent  bool   `json:"neverAssumeAbsent"`
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

// RevocationRules documents E9.4 artifact revoke for Chloe.
type RevocationRules struct {
	Permission      string   `json:"permission"`
	Route           string   `json:"route"`
	Idempotent      bool     `json:"idempotent"`
	BlocksNewRuns   bool     `json:"blocksNewRuns"`
	RecheckOn       []string `json:"recheckOn"`
	FailClosed      bool     `json:"failClosed"`
	ErrorCode       string   `json:"errorCode"`
	AuditAction     string   `json:"auditAction"`
	AuditSecretFree bool     `json:"auditSecretFree"`
	Note            string   `json:"note"`
}

// EmergencyStopRules documents E9.4 authorized runner halt for Chloe.
type EmergencyStopRules struct {
	Permission          string   `json:"permission"`
	Route               string   `json:"route"`
	PolicyGated         bool     `json:"policyGated"`
	MissingPolicyAllows bool     `json:"missingPolicyAllows"`
	PolicyAllowField    string   `json:"policyAllowField"`
	UncertainOutcome    string   `json:"uncertainOutcome"`
	BeforeDispatch      string   `json:"beforeDispatch"`
	NeverAssumeAbsent   bool     `json:"neverAssumeAbsent"`
	States              []string `json:"states"`
	AuditAction         string   `json:"auditAction"`
	AuditSecretFree     bool     `json:"auditSecretFree"`
	DenyWithoutPerm     string   `json:"denyWithoutPermission"`
	Note                string   `json:"note"`
}

// EngineCatalog is the Chloe / worker vocabulary for E9.1–E9.4.
type EngineCatalog struct {
	Languages     []string           `json:"languages"`
	PublishRules  PublishRules       `json:"publishRules"`
	Nodes         []NodeContract     `json:"nodes"`
	Errors        []ErrorShape       `json:"errors"`
	Permissions   []string           `json:"permissions"`
	Isolation     IsolationRules     `json:"isolation"`
	IO            IORules            `json:"io"`
	Retry         RetryRules         `json:"retry"`
	Revocation    RevocationRules    `json:"revocation"`
	EmergencyStop EmergencyStopRules `json:"emergencyStop"`
	Hooks         map[string]string  `json:"hooks"`
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
			RevokedRejected:          true,
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
			Note:  "E9.2 isolated runner plus E9.3 typed I/O plus E9.4 revocation/emergency-stop. Execute rechecks signature, scan, and revoked_at, validates input, injects scoped handles and allowlisted env, then HarnessRuntime (CI) or a live Kubernetes Job. Lease loss and uncertain emergency stop are indeterminate — never a blind re-run.",
			Hooks: []string{"VerifyForDispatch", "Execute", "IsolationSpec", "ValidateExecutionInput", "PublicHandles", "Revoke", "EmergencyStop"},
		},
		IO: IORules{
			MaxInputBytes:        MaxInputBytes,
			MaxOutputBytes:       MaxOutputBytes,
			SecretsForbidden:     true,
			PlaintextCredentials: false,
			HandleInjection:      "scoped-short-lived",
			HandleTTLSeconds:     DefaultHandleTTL,
			HandleMaxTTLSeconds:  MaxHandleTTL,
			AllowlistedEnv:       AllowedRuntimeEnv(),
			ForbiddenEnv:         []string{"AWS_*", "KUBECONFIG", "DOCKER_*", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "PRIVATE_KEY"},
			ValidateBeforeInject: true,
			RedactBeforePersist:  true,
			Note:                 "Inputs are validated against inputSchema and size limits before inject. Only scoped handle ids are injected. Outputs are schema/size checked and redacted before persist/audit.",
		},
		Retry: RetryRules{
			DefaultMaxAttempts:                DefaultMaxAttempts,
			MaxAttempts:                       MaxRetryAttempts,
			RetrySafeFlag:                     "retrySafe",
			IdempotencyKey:                    "idempotencyKey",
			Semantics:                         RetrySemantics,
			Note:                              "Retries default to zero. A node is retry-safe only when it declares retrySafe, an idempotency key, and verification.behavior. Lease loss and unknown outcomes are indeterminate — never a blind re-run.",
			BlindRetry:                        false,
			LeaseLossOutcome:                  "indeterminate",
			UnknownOutcome:                    "indeterminate",
			RequiresIdempotencyKey:            true,
			RequiresVerificationWhenRetrySafe: true,
			Verification:                      RetryVerificationContract,
			WhenRetryAllowed:                  "node retrySafe=true AND idempotencyKey is present AND verification.behavior is declared-hook AND retryPolicy.maxAttempts>0 AND attempts remain AND prior status is failed, canceled, or indeterminate after verification",
			States:                            []string{"queued", "running", "succeeded", "failed", "canceled", "indeterminate"},
			UI: RetryUI{
				IndeterminateBadge: "indeterminate",
				RetrySafeFlag:      "retrySafe",
				RetryEnabledWhen:   "Show Retry when result.retry.allowed is true (retrySafe + idempotencyKey + verification + remaining attempts). Disable/hide Retry for non-retrySafe indeterminate.",
				HideRetryWhen:      "indeterminate without retry.allowed, retry-denied, or maxAttempts=0",
				NeverAssumeAbsent:  true,
			},
			Probe: VerificationRules{
				RequiredWhenRetrySafe: true,
				Field:                 "verification",
				Behavior:              VerificationBehaviorHook,
				OnMatchDefault:        VerifyAlreadyApplied,
				OnMismatchDefault:     VerifySafeToRetry,
				OnError:               VerifyIndeterminate,
				Outcomes:              []string{VerifyAlreadyApplied, VerifySafeToRetry, VerifyIndeterminate},
				Note:                  "declared-hook is an idempotent check of prior output / expect. already-applied resolves success without re-running. safe-to-retry allows one more mutating attempt. indeterminate stays loud and does not re-run.",
			},
		},
		Revocation: RevocationRules{
			Permission:      authz.PermScriptRevoke,
			Route:           "POST /scripts/{artifactId}/revoke",
			Idempotent:      true,
			BlocksNewRuns:   true,
			RecheckOn:       []string{"start", "claim", "heartbeat-before-dispatch", "Execute", "VerifyForDispatch"},
			FailClosed:      true,
			ErrorCode:       CodeArtifactRevoked,
			AuditAction:     AuditRevoke,
			AuditSecretFree: true,
			Note:            "Revoked artifacts cannot start. Dispatch rechecks signature, scan, and revoked_at and fails closed. Already-running executions use emergency stop, not automatic halt.",
		},
		EmergencyStop: EmergencyStopRules{
			Permission:          authz.PermScriptEmergencyStop,
			Route:               "POST /executions/{executionId}/emergency-stop",
			PolicyGated:         true,
			MissingPolicyAllows: true,
			PolicyAllowField:    "policy.allowEmergencyStop",
			UncertainOutcome:    "indeterminate",
			BeforeDispatch:      "canceled",
			NeverAssumeAbsent:   true,
			States:              []string{"queued", "running", "canceled", "indeterminate"},
			AuditAction:         AuditEmergencyStop,
			AuditSecretFree:     true,
			DenyWithoutPerm:     "403 permission-denied",
			Note:                "Requires script.emergencyStop. kind=script policy may set allowEmergencyStop=false (or deny). Running/uncertain stops stay indeterminate until verified — never claim success or failure blindly.",
		},
		Hooks: map[string]string{
			"E9.2": "isolated runner (VerifyForDispatch then Execute)",
			"E9.3": "typed I/O + scoped handles + output redaction + lease-loss recovery",
			"E9.4": "artifact revocation + emergency stop (implemented)",
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
		{Name: "inputSchema", Kind: "object", Description: "Declared input JSON Schema subset. Root type must be object. Validated at publish and again before inject (16 KiB, no secrets)."},
		{Name: "outputSchema", Kind: "object", Description: "Declared output JSON Schema subset. Root type must be object. Runner output is validated as that object (never wrapped) and redacted before persist."},
		{Name: "retrySafe", Kind: "boolean", Description: "Default false. When true, idempotencyKey and verification are required."},
		{Name: "idempotencyKey", Kind: "string", Description: "Required when retrySafe. 1–128 identifier. Declares the node retry-safe with verification."},
		{Name: "verification", Kind: "object", Description: "Required when retrySafe. {behavior:declared-hook, expect?, onMatch, onMismatch, onError}. Never a blind re-run."},
		{Name: "retryPolicy", Kind: "object", Description: "Optional {maxAttempts:0-5}. Default maxAttempts is 0. maxAttempts>0 requires retrySafe + idempotencyKey + verification."},
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
		{Code: CodeInvalidSchema, Status: 400, Meaning: "inputSchema or outputSchema is not the documented JSON Schema subset, root type is not object, or a value failed the declared schema."},
		{Code: CodeSecretForbidden, Status: 400, Meaning: "Source, YAML, persisted input, or output contained secret material (PEM, kubeconfig, tokens)."},
		{Code: CodeSizeLimit, Status: 400, Meaning: "Source, timeout, resource, or I/O size exceeded the documented cap."},
		{Code: CodeInputRejected, Status: 400, Meaning: "Execution input failed schema, size, or secret checks before inject."},
		{Code: CodeOutputTooLarge, Status: 400, Meaning: "Runner output exceeded the 16 KiB persist cap."},
		{Code: CodeArtifactMutable, Status: 400, Meaning: "A draft or unsigned package cannot be executed. Publish first."},
		{Code: CodeArtifactUnscanned, Status: 400, Meaning: "Artifact scan_status is pending or missing."},
		{Code: CodeArtifactUnsigned, Status: 400, Meaning: "Artifact signature is missing or does not verify."},
		{Code: CodeArtifactScanFailed, Status: 400, Meaning: "Artifact scan_status is failed."},
		{Code: CodeArtifactRevoked, Status: 409, Meaning: "Revoked artifacts cannot start. Rechecked at start, claim, heartbeat-before-dispatch, and Execute."},
		{Code: CodePermissionDenied, Status: 403, Meaning: "Missing workflow.execute, script.run, runtimeProfile.use, script.revoke, or script.emergencyStop."},
		{Code: CodePolicyDenied, Status: 403, Meaning: "kind=script policy deny, including emergency-stop deny (allowEmergencyStop=false)."},
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
		{Code: CodeIndeterminate, Status: 409, Meaning: "Lease lost after dispatch, unknown provider outcome, uncertain emergency stop, or verification could not confirm state. Never a silent re-run."},
		{Code: CodeEmergencyStopped, Status: 409, Meaning: "Emergency stop halted the script before dispatch. The runner was not started."},
		{Code: CodeEmergencyStopDenied, Status: 403, Meaning: "Missing script.emergencyStop or kind=script policy denies emergency stop."},
		{Code: CodeRetryDenied, Status: 400, Meaning: "retryPolicy.maxAttempts>0 without retrySafe+idempotencyKey+verification, or a step retry that is not allowed. HTTP execution retry uses 409 retry-denied."},
		{Code: CodeInvalidVerification, Status: 400, Meaning: "retrySafe=true without a valid idempotency key or verification.behavior, or verification set on a non-retrySafe node."},
		{Code: CodeHandleForbidden, Status: 403, Meaning: "Credential handle missing, expired, unscoped, or contained plaintext secrets. Handles only."},
		{Code: CodeEnvDenied, Status: 403, Meaning: "Runtime environment key is outside the allowlist, or plaintext credentials were supplied as env."},
		{Code: CodeRunnerNotImplemented, Status: 501, Meaning: "Live container runtime requested (RequireLiveRuntime) but only the CI harness is available."},
	}
}
