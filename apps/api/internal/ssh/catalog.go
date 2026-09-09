package ssh

// PublishRules documents fail-closed publish/select constraints.
type PublishRules struct {
	SSHTargetRequired        []string `json:"sshTargetRequired"`
	CommandProfileRequired   []string `json:"commandProfileRequired"`
	EmptyAllowlistsRejected  bool     `json:"emptyAllowlistsRejected"`
	CredentialType           string   `json:"credentialType"`
	FingerprintFormat        string   `json:"fingerprintFormat"`
	DraftsNotSelectable      bool     `json:"draftsNotSelectable"`
	PublishedRevisionsPinned bool     `json:"publishedRevisionsPinned"`
	RetrySafeRequiresProbe   bool     `json:"retrySafeRequiresProbe"`
}

// RenderRules documents the reviewed renderer. No raw shell interpolation.
type RenderRules struct {
	Owner                     string   `json:"owner"`
	PlaceholderSyntax         string   `json:"placeholderSyntax"`
	Quoting                   string   `json:"quoting"`
	RawShellInterpolation     bool     `json:"rawShellInterpolation"`
	ForbiddenTokens           []string `json:"forbiddenTokens"`
	RejectValuesOutsideSchema bool     `json:"rejectValuesOutsideSchema"`
}

// RetryRules documents default-zero retries and the verification contract.
type RetryRules struct {
	DefaultMaxAttempts                int      `json:"defaultMaxAttempts"`
	MaxAttempts                       int      `json:"maxAttempts"`
	RetrySafeFlag                     string   `json:"retrySafeFlag"`
	Semantics                         string   `json:"semantics"`
	Note                              string   `json:"note"`
	BlindRetry                        bool     `json:"blindRetry"`
	LeaseLossOutcome                  string   `json:"leaseLossOutcome"`
	UnknownOutcome                    string   `json:"unknownOutcome"`
	RequiresVerificationWhenRetrySafe bool     `json:"requiresVerificationWhenRetrySafe"`
	Verification                      string   `json:"verification"`
	WhenRetryAllowed                  string   `json:"whenRetryAllowed"`
	States                            []string `json:"states"`
	UI                                RetryUI            `json:"ui"`
	Probe                             VerificationRules  `json:"probe"`
}

// VerificationRules documents the profile-declared idempotent probe.
type VerificationRules struct {
	RequiredWhenRetrySafe bool     `json:"requiredWhenRetrySafe"`
	Field                 string   `json:"field"`
	Template              string   `json:"template"`
	ExpectExitCodeDefault int      `json:"expectExitCodeDefault"`
	OnMatchDefault        string   `json:"onMatchDefault"`
	OnMismatchDefault     string   `json:"onMismatchDefault"`
	OnError               string   `json:"onError"`
	Outcomes              []string `json:"outcomes"`
	Note                  string   `json:"note"`
}

// RetryUI is the Chloe contract for badges and retry controls.
type RetryUI struct {
	IndeterminateBadge     string `json:"indeterminateBadge"`
	RetrySafeFlag          string `json:"retrySafeFlag"`
	RetryEnabledWhen       string `json:"retryEnabledWhen"`
	HideRetryWhen          string `json:"hideRetryWhen"`
	NeverAssumeAbsent      bool   `json:"neverAssumeAbsent"`
}

// IsolationRules documents hard denies and connect guarantees for Chloe.
type IsolationRules struct {
	AuthMethods               []string `json:"authMethods"`
	PasswordAuth              bool     `json:"passwordAuth"`
	AgentForwarding           bool     `json:"agentForwarding"`
	PortForwarding            bool     `json:"portForwarding"`
	ProxyCommand              bool     `json:"proxyCommand"`
	HostKeyAutoAccept         bool     `json:"hostKeyAutoAccept"`
	InteractiveShell          bool     `json:"interactiveShell"`
	KnownHostVerification     string   `json:"knownHostVerification"`
	ResolveThenAllowlist      bool     `json:"resolveThenAllowlist"`
	ConnectVerifiedAddress    bool     `json:"connectVerifiedAddressOnly"`
	EphemeralCredentialHandle bool     `json:"ephemeralCredentialHandle"`
	NonRootRemoteAccount      bool     `json:"nonRootRemoteAccount"`
	DefaultUsername           string   `json:"defaultUsername"`
	PrivateKeyNeverExported   bool     `json:"privateKeyNeverExported"`
}

// NodeField is an allowlisted with key for Chloe's library/wizard.
type NodeField struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Required    bool   `json:"required"`
	Description string `json:"description"`
}

// NodeContract is the ssh.run catalog entry (worker is E8.2).
type NodeContract struct {
	Type         string      `json:"type"`
	Verb         string      `json:"verb"`
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

// ErrorShape documents control-plane and future engine failures for Chloe.
type ErrorShape struct {
	Code    string `json:"code"`
	Status  int    `json:"status"`
	Meaning string `json:"meaning"`
}

// EngineCatalog is the Chloe / worker vocabulary for E8.1–E8.3.
type EngineCatalog struct {
	CredentialType         string              `json:"credentialType"`
	CredentialSecretFields []string            `json:"credentialSecretFields"`
	ParameterTypes         []ParameterTypeInfo `json:"parameterTypes"`
	Render                 RenderRules         `json:"render"`
	Retry                  RetryRules          `json:"retry"`
	PublishRules           PublishRules        `json:"publishRules"`
	EvaluationKeys         []EvaluationKey     `json:"evaluationKeys"`
	Nodes                  []NodeContract      `json:"nodes"`
	Errors                 []ErrorShape        `json:"errors"`
	Permissions            []string            `json:"permissions"`
	Isolation              IsolationRules      `json:"isolation"`
}

// Catalog returns documented engine constraints. No SSH connection is made.
func Catalog() EngineCatalog {
	return EngineCatalog{
		CredentialType:         CredentialType,
		CredentialSecretFields: []string{CredentialSecretFieldPrivateKey, CredentialSecretFieldPassphrase},
		ParameterTypes:         AllowedParameterTypes(),
		Render: RenderRules{
			Owner:                     "reviewed-profile-renderer",
			PlaceholderSyntax:         PlaceholderSyntax,
			Quoting:                   QuotingPOSIXSingle,
			RawShellInterpolation:     false,
			ForbiddenTokens:           append([]string(nil), interpolationTokens...),
			RejectValuesOutsideSchema: true,
		},
		Retry: RetryRules{
			DefaultMaxAttempts:                DefaultMaxAttempts,
			MaxAttempts:                       MaxRetryAttempts,
			RetrySafeFlag:                     "retrySafe",
			Semantics:                         RetrySemantics,
			Note:                              "Retries default to zero. Only a pinned retrySafe profile with a declared verification probe and retryPolicy.maxAttempts>0 may retry. Lease loss and unknown provider outcomes are indeterminate — never a blind re-run.",
			BlindRetry:                        false,
			LeaseLossOutcome:                  "indeterminate",
			UnknownOutcome:                    "indeterminate",
			RequiresVerificationWhenRetrySafe: true,
			Verification:                      RetryVerificationContract,
			WhenRetryAllowed:                  "pinned command profile retrySafe=true AND verification.template is present AND retryPolicy.maxAttempts>0 AND attempts remain AND prior status is failed, canceled, or indeterminate after verification",
			States:                            []string{"queued", "running", "succeeded", "failed", "canceled", "indeterminate"},
			UI: RetryUI{
				IndeterminateBadge: "indeterminate",
				RetrySafeFlag:      "retrySafe",
				RetryEnabledWhen:   "Show Retry when result.retry.allowed is true (retrySafe + verification + remaining attempts). Disable/hide Retry for non-retrySafe indeterminate.",
				HideRetryWhen:      "indeterminate without retry.allowed, retry-denied, or maxAttempts=0",
				NeverAssumeAbsent:  true,
			},
			Probe: VerificationRules{
				RequiredWhenRetrySafe: true,
				Field:                 "verification",
				Template:              "Reviewed {name} template using the same parameterSchema. Idempotent read-only probe. Never the mutating command.",
				ExpectExitCodeDefault: 0,
				OnMatchDefault:        VerifyAlreadyApplied,
				OnMismatchDefault:     VerifySafeToRetry,
				OnError:               VerifyIndeterminate,
				Outcomes:              []string{VerifyAlreadyApplied, VerifySafeToRetry, VerifyIndeterminate},
				Note:                  "already-applied resolves success without re-running. safe-to-retry allows one more mutating attempt. indeterminate stays loud and does not re-run.",
			},
		},
		Isolation: IsolationRules{
			AuthMethods:               []string{"publickey"},
			PasswordAuth:              false,
			AgentForwarding:           false,
			PortForwarding:            false,
			ProxyCommand:              false,
			HostKeyAutoAccept:         false,
			InteractiveShell:          false,
			KnownHostVerification:     "fingerprint-match-fail-closed",
			ResolveThenAllowlist:      true,
			ConnectVerifiedAddress:    true,
			EphemeralCredentialHandle: true,
			NonRootRemoteAccount:      true,
			DefaultUsername:           DefaultUsername,
			PrivateKeyNeverExported:   true,
		},
		PublishRules: PublishRules{
			SSHTargetRequired:        []string{"credentialId", "hostname", "hostKeyFingerprint"},
			CommandProfileRequired:   []string{"parameterSchema", "template"},
			EmptyAllowlistsRejected:  true,
			RetrySafeRequiresProbe:   true,
			CredentialType:           CredentialType,
			FingerprintFormat:        "sha256:<64 hex> or OpenSSH SHA256:<base64>",
			DraftsNotSelectable:      true,
			PublishedRevisionsPinned: true,
		},
		EvaluationKeys: EvaluationKeys(),
		Nodes:          NodeContracts(),
		Errors:         ErrorCatalog(),
		Permissions:    RequiredPermissions(),
	}
}

// NodeContracts is the Chloe wizard map for ssh.run (schema only in E8.1).
func NodeContracts() []NodeContract {
	return []NodeContract{
		{
			Type: NodeSSHRun, Verb: VerbRun, Title: "Run command profile",
			Description:  "Pin a workspace SSH target and immutable command-profile revision. Parameters are typed and quoted by the reviewed renderer. The worker uses an ephemeral key handle, verifies known-host fingerprints, allowlists every resolved address, and runs one bounded non-interactive command.",
			Permissions:  RequiredPermissions(),
			RequiredWith: []string{"sshTargetId", "commandProfileId"},
			AllowedWith: []NodeField{
				{Name: "sshTargetId", Kind: "uuid", Required: true, Description: "Published SSH target UUID. YAML stores only the resource id."},
				{Name: "commandProfileId", Kind: "uuid", Required: true, Description: "Published command profile UUID. Workflow publish pins the exact revision."},
				{Name: "parameters", Kind: "object", Description: "Values matching the pinned profile parameterSchema. Rejected when outside the schema."},
				{Name: "timeoutSeconds", Kind: "integer", Description: "Bounded 1–3600. Default 60."},
				{Name: "retryPolicy", Kind: "object", Description: "Optional {maxAttempts:0-5}. Default maxAttempts is 0. maxAttempts>0 requires the pinned profile retrySafe=true plus verification."},
				{Name: "policyId", Kind: "uuid", Description: "Optional published ssh policy UUID."},
			},
			Outputs:     []string{"result", "stdout", "exitCode"},
			SideEffects: true, RetrySafe: false, Idempotent: false,
		},
	}
}

// ErrorCatalog is the RFC 9457-aligned engine error map.
func ErrorCatalog() []ErrorShape {
	return []ErrorShape{
		{Code: CodeInvalidTarget, Status: 400, Meaning: "SSH target is missing required fields or has an invalid hostname/port."},
		{Code: CodeInvalidFingerprint, Status: 400, Meaning: "hostKeyFingerprint is not sha256:<hex> or SHA256:<base64>."},
		{Code: CodeInvalidAddress, Status: 400, Meaning: "allowedAddresses must be IP or CIDR; default-route and unspecified addresses are rejected."},
		{Code: CodeEmptyAllowlist, Status: 400, Meaning: "A present address/host allowlist was empty (fail closed)."},
		{Code: CodeInvalidSchema, Status: 400, Meaning: "parameterSchema is not a restricted typed object schema."},
		{Code: CodeInvalidTemplate, Status: 400, Meaning: "template is missing, uses unknown placeholders, or is not a reviewed profile."},
		{Code: CodeInterpolationDenied, Status: 400, Meaning: "Template or values attempted raw shell interpolation ($(), backticks, ${, {{)."},
		{Code: CodeParameterRejected, Status: 400, Meaning: "A parameter is missing, extra, or outside schema constraints."},
		{Code: CodeCredentialDenied, Status: 400, Meaning: "SSH targets require a workspace ssh_private_key credential."},
		{Code: CodePermissionDenied, Status: 403, Meaning: "Missing workflow.execute, ssh.run, sshTarget.use, or commandProfile.use."},
		{Code: CodeHostKeyMismatch, Status: 403, Meaning: "Presented host key does not match the pinned fingerprint. Auto-accept is disabled."},
		{Code: CodeAddressDenied, Status: 403, Meaning: "A resolved address was outside allowedAddresses, or a DNS name had no allowlist (anti DNS-rebinding / SSRF)."},
		{Code: CodeTimeout, Status: 408, Meaning: "Connection or command exceeded timeoutSeconds."},
		{Code: CodeCanceled, Status: 408, Meaning: "The caller canceled the bounded SSH operation."},
		{Code: CodeAuthDenied, Status: 403, Meaning: "Password or keyboard-interactive authentication was requested. Key-only auth is required."},
		{Code: CodeForwardingDenied, Status: 403, Meaning: "Agent forwarding, port forwarding, proxy commands, or an interactive shell was requested."},
		{Code: CodeRootDenied, Status: 403, Meaning: "Remote account is root (or another denied privileged name)."},
		{Code: CodeHandleForbidden, Status: 403, Meaning: "Credential handle missing, expired, or contained an unusable private key. privateKey is never accepted on the node."},
		{Code: CodeRetryDenied, Status: 400, Meaning: "retryPolicy.maxAttempts>0 without retrySafe+verification, or a step retry that is not allowed. HTTP execution retry uses 409 retry-denied."},
		{Code: CodeInvalidVerification, Status: 400, Meaning: "retrySafe=true but verification is missing/invalid, or verification was set on a non-retrySafe profile."},
		{Code: CodePolicyDenied, Status: 403, Meaning: "SSH policy deny or host/address/operation allowlist failed closed."},
		{Code: CodeConnectFailed, Status: 502, Meaning: "TCP or SSH handshake to the verified address failed."},
		{Code: CodeCommandFailed, Status: 502, Meaning: "The remote command exited non-zero after a known dispatch."},
		{Code: CodeIndeterminate, Status: 409, Meaning: "Lease lost after dispatch, unknown provider outcome, or verification could not confirm state. Never a silent re-run. Chloe: unmistakable indeterminate badge."},
	}
}
