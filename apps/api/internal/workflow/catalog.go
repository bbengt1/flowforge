package workflow

// CoreCatalog is the typed graph vocabulary. E3.3 fills policy, bounds,
// redaction, classification, and allowlisted `with` on the core neutral
// nodes. Next/provider entries are listed so the parser can reject them
// with an actionable unsupported-* code. Triggers are workflow-level.
func CoreCatalog() Catalog {
	return Catalog{
		APIVersion: APIVersionV1,
		Rules: CatalogRules{
			TriggersAreWorkflowLevel:  true,
			GraphNodesExcludeTriggers: true,
			UnsupportedPhasesRejected: true,
		},
		Triggers: triggerTypes(),
		Nodes:    coreNodeTypes(),
	}
}

func triggerTypes() []TriggerType {
	event := []Port{
		{Name: "event", Kind: PortObject, Classification: ClassPublic, MaxBytes: MaxPortBytes, Description: "Validated trigger event."},
		{Name: "context", Kind: PortObject, Classification: ClassInternal, MaxBytes: MaxPortBytes, Description: "Actor, version digest, correlation, and idempotency context."},
	}
	return []TriggerType{
		{
			Type:        "manual",
			Phase:       PhaseCore,
			Title:       "Manual start",
			Description: "Authenticated operator starts a published workflow version. Drafts never run.",
			Outputs:     event,
			AllowedWith: []WithField{
				{Name: "schema", Kind: "schema", Description: "Optional JSON-schema subset for typed start input. Alias: inputSchema. Also accepted as with.schema / with.inputSchema."},
				{Name: "inputSchema", Kind: "schema", Description: "Optional JSON-schema subset for typed start input (alias of schema)."},
			},
			Bounds: defaultNeutralBounds(),
			Redaction: &RedactionPolicy{
				AuditFields:   []string{"actorId", "workflowVersionId", "workflowDigest", "correlationId", "outcome", "idempotencyKey"},
				RedactInputs:  true,
				RedactOutputs: true,
				Strategy:      "mask-classified",
			},
			Start: &TriggerStart{
				Route:                    "POST /api/v1/workflows/{workflowId}/executions",
				Method:                   "POST",
				Permission:               "workflow.execute",
				CSRF:                     true,
				PublishedVersionRequired: true,
				VersionField:             "workflowVersionId",
				InputField:               "input",
				SchemaFields:             []string{"schema", "inputSchema", "with.schema", "with.inputSchema"},
				IdempotencyKeyField:      "idempotencyKey",
				IdempotencyHeader:        "Idempotency-Key",
				IdempotencyKeyRequired:   true,
				IdempotencyKeyPattern:    "^[A-Za-z0-9._~:-]{1,128}$",
				MaxInputBytes:            MaxPortBytes,
				CreatedStatus:            201,
				ReplayStatus:             200,
				ConflictStatus:           409,
				PolicyDenyStatus:         403,
				ApprovalRequiredStatus:   409,
				DraftStatus:              400,
				Help:                     "Run dialog: published-version picker, bounded typed input, idempotency field, CSRF. Body {workflowVersionId, idempotencyKey, input?}. Cookie session + X-CSRF-Token. 201 new / 200 replayed / 409 fingerprint mismatch. Drafts and missing version are 400. Policy deny 403; approval-required 409. Do not invent POST /executions.",
			},
		},
		{
			Type:        "webhook",
			Phase:       PhaseCore,
			Title:       "Webhook",
			Description: "Replay-safe external delivery starts a published workflow version. Signature is verified over the raw body before JSON parse.",
			Outputs:     event,
			AllowedWith: []WithField{
				{Name: "schema", Kind: "schema", Description: "Optional JSON-schema subset for mapped webhook input. Alias: inputSchema."},
				{Name: "inputSchema", Kind: "schema", Description: "Optional JSON-schema subset for mapped webhook input (alias of schema)."},
				{Name: "contentType", Kind: "string", Description: "Accepted Content-Type. MVP allows application/json only."},
			},
			Bounds: defaultNeutralBounds(),
			Redaction: &RedactionPolicy{
				AuditFields:   []string{"triggerId", "workflowVersionId", "workflowDigest", "correlationId", "outcome", "idempotencyKey"},
				RedactInputs:  true,
				RedactOutputs: true,
				Strategy:      "mask-classified",
			},
			Ingress: &TriggerIngress{
				Route:                  "POST /api/v1/hooks/{publicId}",
				Method:                 "POST",
				Public:                 true,
				CSRF:                   false,
				Session:                false,
				SignatureHeader:        "X-FlowForge-Signature",
				TimestampHeader:        "X-FlowForge-Timestamp",
				SignatureVersion:       "v1",
				IdempotencyHeader:      "Idempotency-Key",
				MaxBodyBytes:           65536,
				MaxInputBytes:          MaxPortBytes,
				ClockSkewSeconds:       300,
				ReplayRetentionSeconds: 600,
				DefaultRatePerMinute:   60,
				DefaultWorkspaceRate:   300,
				DefaultMaxConcurrency:  5,
				DefaultWorkspaceConc:   20,
				ContentTypes:           []string{"application/json"},
				CreatedStatus:          201,
				ReplayStatus:           200,
				ConflictStatus:         409,
				UnauthorizedStatus:     401,
				RateLimitedStatus:      429,
				TooLargeStatus:         413,
				DisabledStatus:         404,
				Help:                   "Public ingress. Read raw body, verify v1 HMAC over `v1.{timestamp}.{raw}` before JSON parse. Headers X-FlowForge-Timestamp + X-FlowForge-Signature: v1=<hex>. Fail closed on bad sig, replay, skew, oversize, rate/concurrency, disabled/unpublished. Mapped fields become bounded typed input; start uses E10.1 idempotency/fingerprint. Never put the secret in the URL.",
			},
			Admin: &TriggerAdmin{
				ListRoute:           "GET /api/v1/workflows/{workflowId}/triggers",
				CreateRoute:         "POST /api/v1/workflows/{workflowId}/triggers",
				ItemRoute:           "GET|PATCH|DELETE /api/v1/triggers/{triggerId}",
				RotateRoute:         "POST /api/v1/triggers/{triggerId}/rotate",
				DisableRoute:        "POST /api/v1/triggers/{triggerId}/disable",
				EnableRoute:         "POST /api/v1/triggers/{triggerId}/enable",
				DeleteRoute:         "DELETE /api/v1/triggers/{triggerId}",
				Permission:          "workflow.edit",
				ViewPermission:      "workflow.view",
				CSRF:                true,
				SecretNeverReturned: true,
				Help:                "Cookie session + X-CSRF-Token. Create with published workflowVersionId + secretCredentialId (vault webhook_secret). Response includes opaque publicId and ingressPath. Rotate accepts {secret:{secret}} and never returns plaintext. Host-supplied id/workspaceId is 400.",
			},
		},
		{Type: "schedule", Phase: PhaseCore, Outputs: event},
		{Type: "event", Phase: PhaseNext, Outputs: event},
	}
}

func coreNodeTypes() []NodeType {
	result := Port{Name: "result", Kind: PortObject}
	neutral := coreNeutralTypes()
	return []NodeType{
		neutral["flow.stop"],
		neutral["flow.fail"],
		neutral["flow.condition"],
		neutral["flow.delay"],
		{
			Type: "flow.approval", Phase: PhaseCore,
			Inputs: []Port{{Name: "request", Kind: PortObject}},
			Outputs: []Port{
				{Name: "approved", Kind: PortObject},
				{Name: "rejected", Kind: PortObject},
				{Name: "expired", Kind: PortObject},
			},
			RequiredWith: []string{"approverRole", "expiresIn"},
		},
		neutral["data.set"],
		neutral["data.map"],
		neutral["data.validate"],
		{
			Type: "http.request", Phase: PhaseCore,
			Inputs:       []Port{{Name: "payload", Kind: PortObject}},
			Outputs:      []Port{result},
			RequiredWith: []string{"connectionId"},
		},
		{
			Type: "notification.webhook", Phase: PhaseCore,
			Inputs:       []Port{{Name: "payload", Kind: PortObject}},
			Outputs:      []Port{result},
			RequiredWith: []string{"connectionId"},
		},
		{
			Type: "notification.email", Phase: PhaseCore,
			Inputs:       []Port{{Name: "payload", Kind: PortObject}},
			Outputs:      []Port{result},
			RequiredWith: []string{"connectionId", "recipientListId", "templateId"},
		},
		kubernetesApplyContract(),
		kubernetesGetContract(),
		kubernetesListContract(),
		kubernetesRolloutContract(),
		sshRunContract(),
		scriptPythonContract(),
		scriptGoContract(),
		// Next / provider — rejected at parse time in MVP.
		{Type: "workflow.call", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "flow.switch", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "flow.parallel", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "flow.join", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "flow.forEach", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "flow.waitForEvent", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "data.merge", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "data.filter", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "data.sort", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "artifact.write", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "artifact.read", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "notification.chat", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "servicenow.ticket", Phase: PhaseProvider, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "interlink.request", Phase: PhaseProvider, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "service.restart", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "health.check", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "credential.test", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "configuration.read", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
		{Type: "configuration.write", Phase: PhaseNext, Inputs: []Port{}, Outputs: []Port{}},
	}
}

func lookupTrigger(typ string) (TriggerType, bool) {
	for _, t := range triggerTypes() {
		if t.Type == typ {
			return t, true
		}
	}
	return TriggerType{}, false
}

func lookupNode(typ string) (NodeType, bool) {
	for _, n := range coreNodeTypes() {
		if n.Type == typ {
			return n, true
		}
	}
	return NodeType{}, false
}

func (n NodeType) inputPort(name string) (Port, bool) {
	for _, p := range n.Inputs {
		if p.Name == name {
			return p, true
		}
	}
	return Port{}, false
}

func (n NodeType) outputPort(name string) (Port, bool) {
	for _, p := range n.Outputs {
		if p.Name == name {
			return p, true
		}
	}
	return Port{}, false
}

// Compatible reports whether an output port may feed an input port.
func Compatible(from, to Port) bool {
	if from.Name == "" || to.Name == "" {
		return false
	}
	if to.Kind == PortAny || from.Kind == PortAny {
		return true
	}
	return from.Kind == to.Kind
}
