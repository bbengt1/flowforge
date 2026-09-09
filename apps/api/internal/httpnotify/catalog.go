package httpnotify

// PublishRules documents fail-closed publish/select constraints.
type PublishRules struct {
	YAMLStoresResourceUUIDsOnly bool     `json:"yamlStoresResourceUUIDsOnly"`
	YAMLFields                  []string `json:"yamlFields"`
	DraftsNotSelectable         bool     `json:"draftsNotSelectable"`
	PublishedRevisionsPinned    bool     `json:"publishedRevisionsPinned"`
	ServerAuthorizedSelection   bool     `json:"serverAuthorizedSelection"`
	ConnectionTypes             []string `json:"connectionTypes"`
	EmptyAllowlistsRejected     bool     `json:"emptyAllowlistsRejected"`
}

// IsolationRules documents HTTP/webhook delivery guarantees for Chloe.
type IsolationRules struct {
	NormalizeEndpoint                 bool     `json:"normalizeEndpoint"`
	UserSuppliedURLDenied             bool     `json:"userSuppliedURLDenied"`
	DestinationIPAllowlist            bool     `json:"destinationIPAllowlist"`
	SSRFDenied                        bool     `json:"ssrfDenied"`
	DNSRebindingDenied                bool     `json:"dnsRebindingDenied"`
	ConnectVerifiedAddressOnly        bool     `json:"connectVerifiedAddressOnly"`
	RedirectsDefaultDenied            bool     `json:"redirectsDefaultDenied"`
	RedirectsRevalidated              bool     `json:"redirectsRevalidated"`
	TLSVerificationRequired           bool     `json:"tlsVerificationRequired"`
	InsecureSkipVerifyDenied          bool     `json:"insecureSkipVerifyDenied"`
	RequestResponseSizeLimited        bool     `json:"requestResponseSizeLimited"`
	SecretFieldsPolicyGated           bool     `json:"secretFieldsPolicyGated"`
	ResultsRedactedAndAudited         bool     `json:"resultsRedactedAndAudited"`
	EmailApprovedRevisionsOnly        bool     `json:"emailApprovedRevisionsOnly"`
	MetadataAndLinkLocalDenied        []string `json:"metadataAndLinkLocalDenied"`
	PrivateAndLoopbackDeniedByDefault bool     `json:"privateAndLoopbackDeniedByDefault"`
	AllowPrivateDestinationsOptIn     []string `json:"allowPrivateDestinationsOptIn"`
	Note                              string   `json:"note"`
}

// RetryRules documents default-zero retries (delivery is not retry-safe).
type RetryRules struct {
	DefaultMaxAttempts int    `json:"defaultMaxAttempts"`
	MaxAttempts        int    `json:"maxAttempts"`
	RetrySafe          bool   `json:"retrySafe"`
	BlindRetry         bool   `json:"blindRetry"`
	LeaseLossOutcome   string `json:"leaseLossOutcome"`
	Note               string `json:"note"`
}

// NodeField is an allowlisted with key for Chloe's library/wizard.
type NodeField struct {
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	Required    bool     `json:"required"`
	Enum        []string `json:"enum,omitempty"`
	Description string   `json:"description"`
}

// NodeContract is the catalog entry for one integration node.
type NodeContract struct {
	Type         string      `json:"type"`
	Title        string      `json:"title"`
	Description  string      `json:"description"`
	Permissions  []string    `json:"permissions"`
	RequiredWith []string    `json:"requiredWith"`
	AllowedWith  []NodeField `json:"allowedWith"`
	Outputs      []string    `json:"outputs"`
	SideEffects  bool        `json:"sideEffects"`
	RetrySafe    bool        `json:"retrySafe"`
	Idempotent   bool        `json:"idempotent"`
	Connection   string      `json:"connectionType"`
	Enabled      bool        `json:"enabled"`
}

// ErrorShape documents control-plane and engine failures for Chloe.
type ErrorShape struct {
	Code    string `json:"code"`
	Status  int    `json:"status"`
	Meaning string `json:"meaning"`
}

// IntegrationGate is the E10/E12 enablement contract.
type IntegrationGate struct {
	Name    string   `json:"name"`
	Enabled bool     `json:"enabled"`
	Nodes   []string `json:"nodes"`
	Suites  []string `json:"suites"`
	Note    string   `json:"note"`
}

// EngineCatalog is the Chloe / worker vocabulary for E10.4.
type EngineCatalog struct {
	CredentialType string          `json:"credentialType"`
	PublishRules   PublishRules    `json:"publishRules"`
	Isolation      IsolationRules  `json:"isolation"`
	Retry          RetryRules      `json:"retry"`
	EvaluationKeys []EvaluationKey `json:"evaluationKeys"`
	Nodes          []NodeContract  `json:"nodes"`
	Errors         []ErrorShape    `json:"errors"`
	Permissions    []string        `json:"permissions"`
	Gate           IntegrationGate `json:"integrationGate"`
}

// Catalog returns documented engine constraints. No remote call is made.
func Catalog() EngineCatalog {
	return EngineCatalog{
		CredentialType: CredentialType,
		PublishRules: PublishRules{
			YAMLStoresResourceUUIDsOnly: true,
			YAMLFields:                  []string{"connectionId", "recipientListId", "templateId", "responseSchemaRef", "policyId"},
			DraftsNotSelectable:         true,
			PublishedRevisionsPinned:    true,
			ServerAuthorizedSelection:   true,
			ConnectionTypes:             []string{ConnectionHTTP, ConnectionWebhook, ConnectionSMTP},
			EmptyAllowlistsRejected:     true,
		},
		Isolation: IsolationRules{
			NormalizeEndpoint:                 true,
			UserSuppliedURLDenied:             true,
			DestinationIPAllowlist:            true,
			SSRFDenied:                        true,
			DNSRebindingDenied:                true,
			ConnectVerifiedAddressOnly:        true,
			RedirectsDefaultDenied:            true,
			RedirectsRevalidated:              true,
			TLSVerificationRequired:           true,
			InsecureSkipVerifyDenied:          true,
			RequestResponseSizeLimited:        true,
			SecretFieldsPolicyGated:           true,
			ResultsRedactedAndAudited:         true,
			EmailApprovedRevisionsOnly:        true,
			MetadataAndLinkLocalDenied:        []string{"169.254.0.0/16", "fe80::/10", "fd00:ec2::254"},
			PrivateAndLoopbackDeniedByDefault: true,
			AllowPrivateDestinationsOptIn: []string{
				"endpointPolicy.allowPrivateDestinations",
				"policy.allowPrivateDestinations",
			},
			Note: "Connections resolve hostnames through an approved resolver, then check every destination address (including redirects). Loopback, RFC1918, ULA, and CGNAT are denied unless endpointPolicy.allowPrivateDestinations or a kind=http/notification policy.allowPrivateDestinations is explicitly true (unset fails closed; other policy kinds are ignored). Link-local and metadata addresses (including AWS IPv6 IMDS fd00:ec2::254) stay always denied. Problem details do not echo resolved private IPs.",
		},
		Retry: RetryRules{
			DefaultMaxAttempts: DefaultMaxAttempts,
			MaxAttempts:        MaxRetryAttempts,
			RetrySafe:          false,
			BlindRetry:         false,
			LeaseLossOutcome:   "indeterminate",
			Note:               "HTTP and notification delivery is not retry-safe. Retries stay at zero. Lease loss is indeterminate.",
		},
		EvaluationKeys: EvaluationKeys(),
		Nodes:          NodeContracts(),
		Errors:         ErrorCatalog(),
		Permissions: []string{
			"workflow.execute", "connection.use", "recipientList.use",
			"messageTemplate.use", "responseSchema.use", "policy.use",
		},
		Gate: Gate(),
	}
}

// Gate documents that the integration suite is the enablement check.
func Gate() IntegrationGate {
	return IntegrationGate{
		Name:    "integration",
		Enabled: true,
		Nodes:   IntegrationNodes(),
		Suites:  IntegrationSuites(),
		Note:    "http.request, notification.webhook, and notification.email are catalog-enabled because the negative SSRF/redirect/DNS-rebinding/TLS/secret-field/redaction/tenancy suite is implemented. Set INTEGRATION_ACTIONS_ENABLED=false to disable publish and execute.",
	}
}

// NodeContracts is the Chloe wizard map.
func NodeContracts() []NodeContract {
	return []NodeContract{
		{
			Type: NodeHTTPRequest, Title: "HTTP request",
			Description:  "Call an approved HTTP API through a pinned connection. YAML stores only resource UUIDs. The worker normalizes the endpoint, allowlists every resolved address, enforces method/path/TLS/redirect/size policy, and redacts secret fields.",
			Permissions:  RequiredPermissions(NodeHTTPRequest),
			RequiredWith: []string{"connectionId"},
			AllowedWith:  httpRequestFields(),
			Outputs:      []string{"result"},
			SideEffects:  true, RetrySafe: false, Idempotent: false,
			Connection: ConnectionHTTP, Enabled: true,
		},
		{
			Type: NodeWebhook, Title: "Notification webhook",
			Description:  "Deliver a bounded event to an approved webhook connection. Same SSRF, redirect, TLS, and size controls as http.request, plus an Idempotency-Key header.",
			Permissions:  RequiredPermissions(NodeWebhook),
			RequiredWith: []string{"connectionId"},
			AllowedWith:  webhookFields(),
			Outputs:      []string{"result"},
			SideEffects:  true, RetrySafe: false, Idempotent: true,
			Connection: ConnectionWebhook, Enabled: true,
		},
		{
			Type: NodeEmail, Title: "Notification email",
			Description:  "Send mail through a pinned SMTP connection using only approved recipient-list and message-template revisions. Payload cannot add recipients. Results are redacted and audited.",
			Permissions:  RequiredPermissions(NodeEmail),
			RequiredWith: []string{"connectionId", "recipientListId", "templateId"},
			AllowedWith:  emailFields(),
			Outputs:      []string{"result"},
			SideEffects:  true, RetrySafe: false, Idempotent: false,
			Connection: ConnectionSMTP, Enabled: true,
		},
	}
}

func httpRequestFields() []NodeField {
	return []NodeField{
		{Name: "connectionId", Kind: "uuid", Required: true, Description: "Published HTTP connection UUID. YAML stores only the resource id."},
		{Name: "method", Kind: "enum", Enum: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}, Description: "Must be on the pinned connection endpointPolicy.methods. Default GET."},
		{Name: "path", Kind: "string", Description: "Relative URL path. Must match endpointPolicy.pathPrefixes. Full URLs are denied."},
		{Name: "host", Kind: "string", Description: "Optional host from the pinned connection allowlist when the connection has more than one host."},
		{Name: "timeoutSeconds", Kind: "integer", Description: "Bounded 1–60. Default 15."},
		{Name: "responseSchemaRef", Kind: "uuid", Description: "Optional published response schema UUID. Execution pins the revision."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published http policy UUID."},
	}
}

func webhookFields() []NodeField {
	return []NodeField{
		{Name: "connectionId", Kind: "uuid", Required: true, Description: "Published webhook connection UUID."},
		{Name: "path", Kind: "string", Description: "Relative path under the pinned webhook host. Default /."},
		{Name: "host", Kind: "string", Description: "Optional host from the pinned connection allowlist."},
		{Name: "timeoutSeconds", Kind: "integer", Description: "Bounded 1–60. Default 15."},
		{Name: "idempotencyKey", Kind: "string", Description: "Optional Idempotency-Key value. Default is the execution correlation id."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published notification policy UUID."},
	}
}

func emailFields() []NodeField {
	return []NodeField{
		{Name: "connectionId", Kind: "uuid", Required: true, Description: "Published SMTP connection UUID."},
		{Name: "recipientListId", Kind: "uuid", Required: true, Description: "Published recipient-list UUID. Execution pins the revision."},
		{Name: "templateId", Kind: "uuid", Required: true, Description: "Published message-template UUID. Execution pins the revision."},
		{Name: "policyId", Kind: "uuid", Description: "Optional published notification policy UUID."},
	}
}

// ErrorCatalog is the RFC 9457-aligned engine error map.
func ErrorCatalog() []ErrorShape {
	return []ErrorShape{
		{Code: CodeInvalidConnection, Status: 400, Meaning: "Connection spec is missing required endpointPolicy fields."},
		{Code: CodeInvalidEndpoint, Status: 400, Meaning: "Host/path could not be normalized, or a full URL/userinfo was supplied."},
		{Code: CodeEmptyAllowlist, Status: 400, Meaning: "A present destination-IP or host allowlist was empty (fail closed)."},
		{Code: CodeAddressDenied, Status: 403, Meaning: "A resolved address was outside allowedAddresses, or a DNS name had no allowlist (anti DNS-rebinding)."},
		{Code: CodeSSRFDenied, Status: 403, Meaning: "Destination resolved to loopback, private (RFC1918/ULA), CGNAT, link-local, metadata, unspecified, or multicast. Private/loopback require an explicit allowPrivateDestinations opt-in; link-local and metadata stay always denied. The problem does not echo the resolved address."},
		{Code: CodeRedirectDenied, Status: 403, Meaning: "A redirect was returned when allowRedirects is false, or a hop failed host/IP/TLS/path policy."},
		{Code: CodeMethodDenied, Status: 403, Meaning: "HTTP method is not on the connection allowlist."},
		{Code: CodePathDenied, Status: 403, Meaning: "Path is a full URL or is outside endpointPolicy.pathPrefixes."},
		{Code: CodeTLSRequired, Status: 403, Meaning: "TLS is required and the endpoint was not HTTPS, or TLS verification would be skipped."},
		{Code: CodeOversize, Status: 413, Meaning: "Request or response exceeded the connection or response-schema size limit."},
		{Code: CodeSecretDenied, Status: 403, Meaning: "A secret-bearing field was not authorized by endpointPolicy.secretFields."},
		{Code: CodeWrongConnectionType, Status: 400, Meaning: "Pinned connection type does not match the node (http / webhook / smtp)."},
		{Code: CodeUnpublishedPin, Status: 400, Meaning: "Connection, recipient list, template, or schema pin is a draft or unpublished revision."},
		{Code: CodeTenancyDenied, Status: 403, Meaning: "A pinned resource belongs to another workspace."},
		{Code: CodeRecipientDenied, Status: 403, Meaning: "Payload attempted an email recipient outside the pinned recipient-list revision."},
		{Code: CodeTemplateDenied, Status: 400, Meaning: "Template interpolation used denied syntax, or input did not match the pinned schema."},
		{Code: CodePermissionDenied, Status: 403, Meaning: "Missing workflow.execute or the required *.use permission."},
		{Code: CodePolicyDenied, Status: 403, Meaning: "http/notification policy deny or host/address/operation allowlist failed closed."},
		{Code: CodeTimeout, Status: 408, Meaning: "Delivery exceeded timeoutSeconds."},
		{Code: CodeDeliveryFailed, Status: 502, Meaning: "Remote HTTP/SMTP returned a failure after a known dispatch."},
		{Code: CodeSchemaRejected, Status: 400, Meaning: "Response body did not match the pinned response schema."},
		{Code: CodeInterpolationDenied, Status: 400, Meaning: "Template or values used {{, ${, or other interpolation syntax."},
		{Code: CodeIndeterminate, Status: 409, Meaning: "Lease lost after dispatch. Never a silent re-run."},
	}
}

// HTTPRequestWithFields is the workflow catalog AllowedWith list.
func HTTPRequestWithFields() []NodeField { return httpRequestFields() }

// WebhookWithFields is the workflow catalog AllowedWith list.
func WebhookWithFields() []NodeField { return webhookFields() }

// EmailWithFields is the workflow catalog AllowedWith list.
func EmailWithFields() []NodeField { return emailFields() }
