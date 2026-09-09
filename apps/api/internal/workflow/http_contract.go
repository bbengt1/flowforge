package workflow

import "github.com/bbengt1/flowforge/apps/api/internal/httpnotify"

// IntegrationActionsEnabled is the integration-gate kill switch.
// Default true because the negative suite lives in package httpnotify.
// Set false via INTEGRATION_ACTIONS_ENABLED=false.
var IntegrationActionsEnabled = true

func httpnotifyGate() IntegrationGate {
	g := httpnotify.Gate()
	g.Enabled = IntegrationActionsEnabled
	return IntegrationGate{
		Name:    g.Name,
		Enabled: g.Enabled,
		Nodes:   append([]string(nil), g.Nodes...),
		Suites:  append([]string(nil), g.Suites...),
		Note:    g.Note,
	}
}

func isIntegrationNode(typ string) bool {
	switch typ {
	case httpnotify.NodeHTTPRequest, httpnotify.NodeWebhook, httpnotify.NodeEmail:
		return true
	default:
		return false
	}
}

func httpNotifyBounds() *NodeBounds {
	return &NodeBounds{
		MaxInputBytes:       httpnotify.DefaultMaxRequestBytes,
		MaxOutputBytes:      httpnotify.DefaultMaxResponseBytes,
		MaxWithBytes:        MaxPortBytes,
		MaxAggregationItems: MaxAggregationItems,
		MaxDurationSeconds:  httpnotify.MaxTimeoutSeconds,
	}
}

func httpRequestContract() NodeType {
	return NodeType{
		Type:        httpnotify.NodeHTTPRequest,
		Phase:       PhaseCore,
		Title:       "HTTP request",
		Description: "Call an approved HTTP API through a pinned connection. YAML stores only resource UUIDs. Endpoint, destination-IP, redirect, method/path, TLS, and size policies are enforced; results are redacted.",
		Inputs: []Port{
			{Name: "payload", Kind: PortObject, Classification: ClassInternal, MaxBytes: httpnotify.DefaultMaxRequestBytes, Description: "Optional JSON body for POST/PUT/PATCH. Secret keys require connection secretFields."},
		},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassInternal, MaxBytes: httpnotify.DefaultMaxResponseBytes, Description: "Redacted status, host, and body. Never includes Authorization or secret fields."},
		},
		RequiredWith: []string{"connectionId"},
		AllowedWith:  toWithFields(httpnotify.HTTPRequestWithFields()),
		Policy: &NodePolicy{
			Permissions:        httpnotify.RequiredPermissions(httpnotify.NodeHTTPRequest),
			RetrySafe:          false,
			SideEffects:        true,
			Idempotent:         false,
			Cancellation:       "abort-request",
			Verification:       "none",
			DefaultMaxAttempts: httpnotify.DefaultMaxAttempts,
		},
		Bounds: httpNotifyBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"connectionId", "method", "host", "path", "statusCode", "correlationId"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func notificationWebhookContract() NodeType {
	return NodeType{
		Type:        httpnotify.NodeWebhook,
		Phase:       PhaseCore,
		Title:       "Notification webhook",
		Description: "Deliver a bounded event to a pinned webhook connection. Same SSRF/redirect/TLS/size controls as http.request, plus an Idempotency-Key header.",
		Inputs: []Port{
			{Name: "payload", Kind: PortObject, Classification: ClassInternal, MaxBytes: httpnotify.DefaultMaxRequestBytes, Description: "Event body. Secret keys require connection secretFields."},
		},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassInternal, MaxBytes: httpnotify.DefaultMaxResponseBytes, Description: "Redacted delivery summary."},
		},
		RequiredWith: []string{"connectionId"},
		AllowedWith:  toWithFields(httpnotify.WebhookWithFields()),
		Policy: &NodePolicy{
			Permissions:        httpnotify.RequiredPermissions(httpnotify.NodeWebhook),
			RetrySafe:          false,
			SideEffects:        true,
			Idempotent:         true,
			Cancellation:       "abort-request",
			Verification:       "none",
			DefaultMaxAttempts: httpnotify.DefaultMaxAttempts,
		},
		Bounds: httpNotifyBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"connectionId", "method", "host", "path", "statusCode", "correlationId"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func notificationEmailContract() NodeType {
	return NodeType{
		Type:        httpnotify.NodeEmail,
		Phase:       PhaseCore,
		Title:       "Notification email",
		Description: "Send mail through a pinned SMTP connection using only approved recipient-list and message-template revisions. Payload cannot add recipients.",
		Inputs: []Port{
			{Name: "payload", Kind: PortObject, Classification: ClassInternal, MaxBytes: httpnotify.DefaultMaxRequestBytes, Description: "Typed template inputs. to/recipients/body/html are denied."},
		},
		Outputs: []Port{
			{Name: "result", Kind: PortObject, Classification: ClassPublic, MaxBytes: MaxPortBytes, Description: "Redacted recipient count and template ids. Never includes addresses beyond count/domains."},
		},
		RequiredWith: []string{"connectionId", "recipientListId", "templateId"},
		AllowedWith:  toWithFields(httpnotify.EmailWithFields()),
		Policy: &NodePolicy{
			Permissions:        httpnotify.RequiredPermissions(httpnotify.NodeEmail),
			RetrySafe:          false,
			SideEffects:        true,
			Idempotent:         false,
			Cancellation:       "abort-send",
			Verification:       "none",
			DefaultMaxAttempts: httpnotify.DefaultMaxAttempts,
		},
		Bounds: httpNotifyBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"connectionId", "recipientListId", "templateId", "recipientCount", "correlationId"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "drop-secrets",
		},
	}
}

func toWithFields(in []httpnotify.NodeField) []WithField {
	out := make([]WithField, 0, len(in))
	for _, f := range in {
		out = append(out, WithField{
			Name:        f.Name,
			Kind:        f.Kind,
			Required:    f.Required,
			Enum:        append([]string(nil), f.Enum...),
			Description: f.Description,
		})
	}
	return out
}
