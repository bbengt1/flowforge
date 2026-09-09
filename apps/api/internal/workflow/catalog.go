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
		{Name: "event", Kind: PortObject},
		{Name: "context", Kind: PortObject},
	}
	return []TriggerType{
		{Type: "manual", Phase: PhaseCore, Outputs: event},
		{Type: "webhook", Phase: PhaseCore, Outputs: event},
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
		{
			Type: "kubernetes.rolloutStatus", Phase: PhaseCore,
			Inputs:       []Port{{Name: "resource", Kind: PortObject, Required: true}},
			Outputs:      []Port{result, {Name: "status", Kind: PortObject}},
			RequiredWith: []string{"clusterTargetId", "namespace"},
		},
		{
			Type: "ssh.run", Phase: PhaseCore,
			Inputs: []Port{{Name: "parameters", Kind: PortObject}},
			Outputs: []Port{
				result,
				{Name: "stdout", Kind: PortString},
				{Name: "exitCode", Kind: PortInteger},
			},
			RequiredWith: []string{"sshTargetId", "commandProfileId"},
		},
		{
			Type: "script.python", Phase: PhaseCore,
			Inputs:       []Port{{Name: "input", Kind: PortObject}},
			Outputs:      []Port{result},
			RequiredWith: []string{"source", "entrypoint", "runtimeProfileId", "timeoutSeconds"},
		},
		{
			Type: "script.go", Phase: PhaseCore,
			Inputs:       []Port{{Name: "input", Kind: PortObject}},
			Outputs:      []Port{result},
			RequiredWith: []string{"source", "entrypoint", "runtimeProfileId", "timeoutSeconds"},
		},
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
