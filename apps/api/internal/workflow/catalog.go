package workflow

// CoreCatalog is the E3.1 typed graph vocabulary. Next/provider entries are
// listed so the parser can reject them with an actionable unsupported-* code.
func CoreCatalog() Catalog {
	return Catalog{
		APIVersion: APIVersionV1,
		Triggers:   triggerTypes(),
		Nodes:      coreNodeTypes(),
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
	return []NodeType{
		{
			Type: "flow.stop", Phase: PhaseCore,
			Inputs:  []Port{{Name: "input", Kind: PortAny}},
			Outputs: []Port{result},
		},
		{
			Type: "flow.fail", Phase: PhaseCore,
			Inputs:  []Port{{Name: "input", Kind: PortAny}},
			Outputs: []Port{result},
		},
		{
			Type: "flow.condition", Phase: PhaseCore,
			Inputs:       []Port{{Name: "value", Kind: PortAny, Required: true}},
			Outputs:      []Port{{Name: "true", Kind: PortAny}, {Name: "false", Kind: PortAny}},
			RequiredWith: []string{"op"},
		},
		{
			Type: "flow.delay", Phase: PhaseCore,
			Inputs:       []Port{{Name: "input", Kind: PortAny}},
			Outputs:      []Port{result},
			RequiredWith: []string{"duration"},
		},
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
		{
			Type: "data.set", Phase: PhaseCore,
			Outputs:      []Port{result},
			RequiredWith: []string{"value"},
		},
		{
			Type: "data.map", Phase: PhaseCore,
			Inputs:       []Port{{Name: "input", Kind: PortObject, Required: true}},
			Outputs:      []Port{result},
			RequiredWith: []string{"mapping"},
		},
		{
			Type: "data.validate", Phase: PhaseCore,
			Inputs:       []Port{{Name: "value", Kind: PortAny, Required: true}},
			Outputs:      []Port{result},
			RequiredWith: []string{"schema"},
		},
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
		{
			Type: "kubernetes.apply", Phase: PhaseCore,
			Inputs: []Port{
				{Name: "manifests", Kind: PortString},
				{Name: "parameters", Kind: PortObject},
			},
			Outputs: []Port{
				result,
				{Name: "resources", Kind: PortObject},
				{Name: "status", Kind: PortObject},
			},
			RequiredWith: []string{"clusterTargetId", "namespace"},
		},
		{
			Type: "kubernetes.get", Phase: PhaseCore,
			Inputs:       []Port{{Name: "parameters", Kind: PortObject}},
			Outputs:      []Port{result, {Name: "items", Kind: PortObject}},
			RequiredWith: []string{"clusterTargetId", "namespace"},
		},
		{
			Type: "kubernetes.list", Phase: PhaseCore,
			Inputs:       []Port{{Name: "parameters", Kind: PortObject}},
			Outputs:      []Port{result, {Name: "items", Kind: PortObject}},
			RequiredWith: []string{"clusterTargetId", "namespace"},
		},
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
		{Type: "workflow.call", Phase: PhaseNext},
		{Type: "flow.switch", Phase: PhaseNext},
		{Type: "flow.parallel", Phase: PhaseNext},
		{Type: "flow.join", Phase: PhaseNext},
		{Type: "flow.forEach", Phase: PhaseNext},
		{Type: "flow.waitForEvent", Phase: PhaseNext},
		{Type: "data.merge", Phase: PhaseNext},
		{Type: "data.filter", Phase: PhaseNext},
		{Type: "data.sort", Phase: PhaseNext},
		{Type: "artifact.write", Phase: PhaseNext},
		{Type: "artifact.read", Phase: PhaseNext},
		{Type: "notification.chat", Phase: PhaseNext},
		{Type: "servicenow.ticket", Phase: PhaseProvider},
		{Type: "interlink.request", Phase: PhaseProvider},
		{Type: "service.restart", Phase: PhaseNext},
		{Type: "health.check", Phase: PhaseNext},
		{Type: "credential.test", Phase: PhaseNext},
		{Type: "configuration.read", Phase: PhaseNext},
		{Type: "configuration.write", Phase: PhaseNext},
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
