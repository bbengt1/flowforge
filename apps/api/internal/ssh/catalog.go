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

// RetryRules documents the explicit retry field. E8.2 never blindly re-runs.
type RetryRules struct {
	DefaultMaxAttempts int    `json:"defaultMaxAttempts"`
	RetrySafeFlag      string `json:"retrySafeFlag"`
	Semantics          string `json:"semantics"`
	Note               string `json:"note"`
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
			DefaultMaxAttempts: DefaultMaxAttempts,
			RetrySafeFlag:      "retrySafe",
			Semantics:          "E8.3",
			Note:               "Retries default to zero. E8.2 never blindly re-runs. A profile may set retrySafe=true and retryPolicy.maxAttempts>0; E8.3 implements verification before any retry. Lease loss is indeterminate.",
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
				{Name: "retryPolicy", Kind: "object", Description: "Optional {maxAttempts:0-5}. Default maxAttempts is 0. retrySafe semantics are E8.3."},
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
		{Code: CodeRetryDenied, Status: 400, Meaning: "retryPolicy.maxAttempts>0 requires retrySafe. E8.2 still does not retry."},
		{Code: CodePolicyDenied, Status: 403, Meaning: "SSH policy deny or host/address/operation allowlist failed closed."},
		{Code: CodeConnectFailed, Status: 502, Meaning: "TCP or SSH handshake to the verified address failed."},
		{Code: CodeCommandFailed, Status: 502, Meaning: "The remote command could not be started or the session failed."},
		{Code: CodeIndeterminate, Status: 409, Meaning: "Lease was lost after dispatch. E8.2 does not retry; E8.3 adds profile verification."},
	}
}
