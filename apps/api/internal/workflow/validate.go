package workflow

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
)

var (
	ianaTZRE     = regexp.MustCompile(`^(UTC|GMT|[A-Za-z]+(?:/[A-Za-z0-9_+-]+)+)$`)
	cronRE       = regexp.MustCompile(`^([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)$`)
	httpPathRE   = regexp.MustCompile(`^/`)
	pemOrTokenRE = regexp.MustCompile(`(?i)(-----BEGIN |Bearer |ghp_|sk-|xox[baprs]-)`)
)

var resourceUUIDFields = map[string]bool{
	"clusterTargetId":   true,
	"sshTargetId":       true,
	"commandProfileId":  true,
	"runtimeProfileId":  true,
	"connectionId":      true,
	"recipientListId":   true,
	"templateId":        true,
	"responseSchemaRef": true,
	"policyId":          true,
}

var forbiddenWithByType = map[string][]string{
	"ssh.run":                  {"command", "host", "hostname", "password", "privateKey", "credential", "kubeconfig"},
	"http.request":             {"url", "insecureSkipVerify", "authorization", "headers"},
	"notification.webhook":     {"url", "secret", "endpoint"},
	"notification.email":       {"to", "recipients", "body", "html"},
	"kubernetes.apply":         {"force", "kubeconfig", "server"},
	"kubernetes.get":           {"kubeconfig", "server"},
	"kubernetes.list":          {"kubeconfig", "server"},
	"kubernetes.rolloutStatus": {"kubeconfig", "server"},
	"script.python":            {"env", "environment", "secrets", "credentials", "privateKey", "token", "password", "kubeconfig", "command", "shell"},
	"script.go":                {"env", "environment", "secrets", "credentials", "privateKey", "token", "password", "kubeconfig", "command", "shell"},
}

func validate(doc *Document) ErrorList {
	var errs ErrorList
	if doc.APIVersion != APIVersionV1 {
		errs = append(errs, fieldError("apiVersion", doc.pos.root.Line, doc.pos.root.Column, CodeInvalidAPIVersion, "Unsupported apiVersion. Expected flowforge/v1."))
	}
	if doc.Kind != KindWorkflow {
		errs = append(errs, fieldError("kind", doc.pos.root.Line, doc.pos.root.Column, CodeInvalidKind, "Unsupported kind. Expected Workflow."))
	}
	if !validDNSLabel(doc.Metadata.Name) {
		errs = append(errs, fieldError("metadata.name", doc.pos.name.Line, doc.pos.metadata.Line, CodeInvalidName, "metadata.name must be a DNS label (lowercase letters, numbers, hyphens; start with a letter)."))
	}
	for k := range doc.Metadata.Labels {
		if !validLabelKey(k) {
			errs = append(errs, fieldError("metadata.labels."+k, doc.pos.metadata.Line, 0, CodeInvalidName, "Label keys must be DNS labels or prefix/name."))
		}
	}

	if len(doc.Spec.Triggers) == 0 {
		errs = append(errs, fieldError("spec.triggers", doc.pos.spec.Line, doc.pos.spec.Column, CodeMissingField, "At least one trigger is required."))
	}
	if len(doc.Spec.Nodes) == 0 {
		errs = append(errs, fieldError("spec.nodes", doc.pos.spec.Line, doc.pos.spec.Column, CodeMissingField, "At least one node is required."))
	}

	seenTriggers := map[string]int{}
	for i, t := range doc.Spec.Triggers {
		path := fmt.Sprintf("spec.triggers[%d]", i)
		if !validDNSLabel(t.ID) {
			errs = append(errs, fieldError(path+".id", t.pos.Line, t.pos.Column, CodeInvalidID, "Trigger id must be a DNS label."))
		}
		if prev, ok := seenTriggers[t.ID]; ok && t.ID != "" {
			errs = append(errs, fieldError(path+".id", t.pos.Line, t.pos.Column, CodeDuplicateID, fmt.Sprintf("Trigger id %q is already used at spec.triggers[%d].", t.ID, prev)))
		} else if t.ID != "" {
			seenTriggers[t.ID] = i
		}
		errs = append(errs, validateTrigger(t, path)...)
	}

	nodesByID := map[string]int{}
	for i, n := range doc.Spec.Nodes {
		path := fmt.Sprintf("spec.nodes[%d]", i)
		if !validDNSLabel(n.ID) {
			errs = append(errs, fieldError(path+".id", n.pos.Line, n.pos.Column, CodeInvalidID, "Node id must be a DNS label."))
		}
		if strings.TrimSpace(n.Name) == "" {
			errs = append(errs, fieldError(path+".name", n.pos.Line, n.pos.Column, CodeMissingField, "Node name is required."))
		}
		if prev, ok := nodesByID[n.ID]; ok && n.ID != "" {
			errs = append(errs, fieldError(path+".id", n.pos.Line, n.pos.Column, CodeDuplicateID, fmt.Sprintf("Node id %q is already used at spec.nodes[%d].", n.ID, prev)))
		} else if n.ID != "" {
			nodesByID[n.ID] = i
		}
		errs = append(errs, validateNode(n, path)...)
	}

	seenTo := map[string]int{}
	seenEdge := map[string]int{}
	for i, e := range doc.Spec.Edges {
		path := fmt.Sprintf("spec.edges[%d]", i)
		from, fromOK := parsePortRef(e.From)
		if !fromOK {
			errs = append(errs, fieldError(path+".from", e.pos.Line, e.pos.Column, CodeInvalidPort, "Edge from must be nodeId.port."))
		}
		to, toOK := parsePortRef(e.To)
		if !toOK {
			errs = append(errs, fieldError(path+".to", e.pos.Line, e.pos.Column, CodeInvalidPort, "Edge to must be nodeId.port."))
		}
		key := e.From + "->" + e.To
		if prev, ok := seenEdge[key]; ok {
			errs = append(errs, fieldError(path, e.pos.Line, e.pos.Column, CodeDuplicateEdge, fmt.Sprintf("Duplicate edge already declared at spec.edges[%d].", prev)))
		} else {
			seenEdge[key] = i
		}
		if toOK {
			if prev, ok := seenTo[e.To]; ok {
				errs = append(errs, fieldError(path+".to", e.pos.Line, e.pos.Column, CodeDuplicateEdge, fmt.Sprintf("Input %q is already wired at spec.edges[%d].", e.To, prev)))
			} else {
				seenTo[e.To] = i
			}
		}
		if fromOK && toOK {
			errs = append(errs, validateEdgePorts(doc, e, from, to, path)...)
		}
	}

	seenOutputs := map[string]int{}
	for i, o := range doc.Spec.Outputs {
		path := fmt.Sprintf("spec.outputs[%d]", i)
		if !validDNSLabel(o.Name) {
			errs = append(errs, fieldError(path+".name", o.pos.Line, o.pos.Column, CodeInvalidName, "Output name must be a DNS label."))
		}
		if prev, ok := seenOutputs[o.Name]; ok && o.Name != "" {
			errs = append(errs, fieldError(path+".name", o.pos.Line, o.pos.Column, CodeDuplicateID, fmt.Sprintf("Output name %q is already used at spec.outputs[%d].", o.Name, prev)))
		} else if o.Name != "" {
			seenOutputs[o.Name] = i
		}
		ref, ok := parsePortRef(o.From)
		if !ok {
			errs = append(errs, fieldError(path+".from", o.pos.Line, o.pos.Column, CodeInvalidPort, "Output from must be nodeId.port."))
			continue
		}
		ni, exists := nodesByID[ref.NodeID]
		if !exists {
			errs = append(errs, fieldError(path+".from", o.pos.Line, o.pos.Column, CodeUnresolvedReference, fmt.Sprintf("Output references unknown node %q.", ref.NodeID)))
			continue
		}
		nt, ok := lookupNode(doc.Spec.Nodes[ni].Type)
		if !ok {
			continue
		}
		if _, ok := nt.outputPort(ref.Port); !ok {
			errs = append(errs, fieldError(path+".from", o.pos.Line, o.pos.Column, CodeInvalidPort, fmt.Sprintf("Node %q has no output port %q.", ref.NodeID, ref.Port)))
		}
	}

	errs = append(errs, validateGraph(doc, nodesByID)...)
	return errs
}

func validateTrigger(t Trigger, path string) ErrorList {
	var errs ErrorList
	tt, ok := lookupTrigger(t.Type)
	if !ok {
		errs = append(errs, fieldError(path+".type", t.pos.Line, t.pos.Column, CodeUnknownTriggerType, fmt.Sprintf("Unknown trigger type %q.", t.Type)))
		return errs
	}
	if tt.Phase != PhaseCore {
		errs = append(errs, fieldError(path+".type", t.pos.Line, t.pos.Column, CodeUnsupportedTrigger, fmt.Sprintf("Trigger type %q is not enabled in MVP.", t.Type)))
		return errs
	}
	switch t.Type {
	case "manual":
		errs = append(errs, validateManualTrigger(t, path)...)
	case "webhook":
		for k, v := range t.With {
			switch k {
			case "inputSchema":
				if _, ok := v.(map[string]any); !ok && v != nil {
					errs = append(errs, fieldError(path+".inputSchema", t.pos.Line, t.pos.Column, CodeInvalidType, "inputSchema must be a mapping."))
				}
			case "contentType":
				s, ok := v.(string)
				if !ok || strings.TrimSpace(s) == "" {
					errs = append(errs, fieldError(path+".contentType", t.pos.Line, t.pos.Column, CodeInvalidType, "contentType must be a string."))
				}
			default:
				errs = append(errs, fieldError(path+"."+k, t.pos.Line, t.pos.Column, CodeUnknownField, "webhook YAML may declare only inputSchema and contentType."))
			}
		}
	case "schedule":
		errs = append(errs, validateSchedule(t, path)...)
	}
	errs = append(errs, scanUnsafe(t.With, path)...)
	return errs
}

func validateSchedule(t Trigger, path string) ErrorList {
	var errs ErrorList
	if _, ok := t.With["timezone"]; !ok {
		errs = append(errs, fieldError(path+".timezone", t.pos.Line, t.pos.Column, CodeMissingField, "schedule requires an IANA timezone."))
	} else if s, ok := t.With["timezone"].(string); !ok || !ianaTZRE.MatchString(s) {
		errs = append(errs, fieldError(path+".timezone", t.pos.Line, t.pos.Column, CodeInvalidWith, "timezone must be an IANA name such as UTC or America/Chicago."))
	}
	_, hasCron := t.With["cron"]
	_, hasInterval := t.With["interval"]
	if hasCron == hasInterval {
		errs = append(errs, fieldError(path, t.pos.Line, t.pos.Column, CodeInvalidWith, "schedule requires exactly one of cron or interval."))
	}
	if hasCron {
		s, ok := t.With["cron"].(string)
		if !ok || !cronRE.MatchString(s) {
			errs = append(errs, fieldError(path+".cron", t.pos.Line, t.pos.Column, CodeInvalidWith, "cron must be a 5-field expression."))
		}
	}
	if hasInterval {
		s, ok := t.With["interval"].(string)
		if !ok || !validISODuration(s) {
			errs = append(errs, fieldError(path+".interval", t.pos.Line, t.pos.Column, CodeInvalidWith, "interval must be an ISO-8601 duration."))
		}
	}
	if v, ok := t.With["overlapPolicy"]; !ok {
		errs = append(errs, fieldError(path+".overlapPolicy", t.pos.Line, t.pos.Column, CodeMissingField, "schedule requires an explicit overlapPolicy."))
	} else if s, ok := v.(string); !ok || !oneOf(s, "skip", "reject", "queue") {
		errs = append(errs, fieldError(path+".overlapPolicy", t.pos.Line, t.pos.Column, CodeInvalidWith, "overlapPolicy must be skip, reject, or queue."))
	}
	if v, ok := t.With["misfirePolicy"]; ok {
		if s, ok := v.(string); !ok || !oneOf(s, "ignore", "fire-once") {
			errs = append(errs, fieldError(path+".misfirePolicy", t.pos.Line, t.pos.Column, CodeInvalidWith, "misfirePolicy must be ignore or fire-once."))
		}
	}
	if v, ok := t.With["catchUp"]; ok {
		switch n := v.(type) {
		case bool:
			if n {
				errs = append(errs, fieldError(path+".catchUp", t.pos.Line, t.pos.Column, CodeInvalidWith, "catchUp must be false or a bounded integer 0-5."))
			}
		case int64:
			if n < 0 || n > 5 {
				errs = append(errs, fieldError(path+".catchUp", t.pos.Line, t.pos.Column, CodeInvalidWith, "catchUp must be between 0 and 5."))
			}
		default:
			errs = append(errs, fieldError(path+".catchUp", t.pos.Line, t.pos.Column, CodeInvalidType, "catchUp must be false or an integer."))
		}
	}
	allowed := map[string]bool{"timezone": true, "cron": true, "interval": true, "overlapPolicy": true, "misfirePolicy": true, "catchUp": true}
	for k := range t.With {
		if !allowed[k] {
			errs = append(errs, fieldError(path+"."+k, t.pos.Line, t.pos.Column, CodeUnknownField, fmt.Sprintf("Unknown schedule field %q.", k)))
		}
	}
	return errs
}

func validateNode(n Node, path string) ErrorList {
	var errs ErrorList
	nt, ok := lookupNode(n.Type)
	if !ok {
		errs = append(errs, fieldError(path+".type", n.pos.Line, n.pos.Column, CodeUnknownNodeType, fmt.Sprintf("Unknown node type %q.", n.Type)))
		return errs
	}
	if nt.Phase != PhaseCore {
		errs = append(errs, fieldError(path+".type", n.pos.Line, n.pos.Column, CodeUnsupportedNode, fmt.Sprintf("Node type %q is not enabled in MVP.", n.Type)))
		return errs
	}
	if n.With == nil {
		n.With = map[string]any{}
	}
	for _, req := range nt.RequiredWith {
		if _, ok := n.With[req]; !ok {
			errs = append(errs, fieldError(path+".with."+req, n.pos.Line, n.pos.Column, CodeMissingField, fmt.Sprintf("%s requires with.%s.", n.Type, req)))
		}
	}
	for _, forbidden := range forbiddenWithByType[n.Type] {
		if _, ok := n.With[forbidden]; ok {
			errs = append(errs, fieldError(path+".with."+forbidden, n.pos.Line, n.pos.Column, CodeUnsafeReference, fmt.Sprintf("%s cannot declare %s.", n.Type, forbidden)))
		}
	}
	for k, v := range n.With {
		if resourceUUIDFields[k] {
			s, ok := v.(string)
			if !ok || !validUUID(s) {
				errs = append(errs, fieldError(path+".with."+k, n.pos.Line, n.pos.Column, CodeInvalidUUID, k+" must be a workspace-scoped UUID."))
			}
		}
	}
	errs = append(errs, scanUnsafe(n.With, path+".with")...)
	errs = append(errs, scanUnsafe(n.Inputs, path+".inputs")...)
	for k := range n.Inputs {
		if _, ok := nt.inputPort(k); !ok {
			errs = append(errs, fieldError(path+".inputs."+k, n.pos.Line, n.pos.Column, CodeInvalidPort, fmt.Sprintf("Node type %q has no input port %q.", n.Type, k)))
		}
	}
	if isCoreNeutral(n.Type) {
		errs = append(errs, validateCoreNeutralNode(n, path)...)
	} else {
		errs = append(errs, validateAllowedWith(n, nt, path)...)
		errs = append(errs, validateNodeWith(n, path)...)
	}
	return errs
}

func validateAllowedWith(n Node, nt NodeType, path string) ErrorList {
	if len(nt.AllowedWith) == 0 {
		return nil
	}
	var errs ErrorList
	allowed := allowedWithNames(nt)
	for k := range n.With {
		if !allowed[k] {
			errs = append(errs, fieldError(path+".with."+k, n.pos.Line, n.pos.Column, CodeUnknownField, fmt.Sprintf("%s does not allow with.%s.", n.Type, k)))
		}
	}
	return errs
}

func validateNodeWith(n Node, path string) ErrorList {
	var errs ErrorList
	switch n.Type {
	case "kubernetes.apply", "kubernetes.get", "kubernetes.list", "kubernetes.rolloutStatus":
		if ns, ok := n.With["namespace"].(string); ok && !validDNSLabel(ns) {
			errs = append(errs, fieldError(path+".with.namespace", n.pos.Line, n.pos.Column, CodeInvalidName, "namespace must be a DNS label."))
		}
		if v, ok := n.With["dryRun"]; ok {
			s, ok := v.(string)
			if !ok || !oneOf(s, "client", "server") {
				errs = append(errs, fieldError(path+".with.dryRun", n.pos.Line, n.pos.Column, CodeInvalidWith, "dryRun must be client or server."))
			}
		}
		if v, ok := n.With["fieldManager"]; ok {
			s, ok := v.(string)
			if !ok || s != "flowforge" {
				errs = append(errs, fieldError(path+".with.fieldManager", n.pos.Line, n.pos.Column, CodeInvalidWith, "fieldManager is service-owned and must be flowforge."))
			}
		}
		if v, ok := n.With["wait"]; ok {
			s, ok := v.(string)
			if !ok || !oneOf(s, "none", "ready") {
				errs = append(errs, fieldError(path+".with.wait", n.pos.Line, n.pos.Column, CodeInvalidWith, "wait must be none or ready."))
			}
		}
		errs = append(errs, validateTimeout(n.With, path)...)
		if n.Type == "kubernetes.get" || n.Type == "kubernetes.list" {
			if raw, ok := n.With["kind"]; ok {
				s, ok := raw.(string)
				if !ok || !kubernetes.KindAllowed(s) {
					errs = append(errs, fieldError(path+".with.kind", n.pos.Line, n.pos.Column, CodeInvalidWith, "kind must be an allowlisted Kubernetes kind."))
				}
			}
		}
		if n.Type == "kubernetes.rolloutStatus" {
			if raw, ok := n.With["kind"]; ok {
				s, ok := raw.(string)
				if !ok || !kubernetes.ObservableKind(s) {
					errs = append(errs, fieldError(path+".with.kind", n.pos.Line, n.pos.Column, CodeInvalidWith, "kind must be Deployment, StatefulSet, DaemonSet, or Job."))
				}
			}
			if raw, ok := n.With["name"]; ok {
				s, ok := raw.(string)
				if !ok || !validDNSLabel(s) {
					errs = append(errs, fieldError(path+".with.name", n.pos.Line, n.pos.Column, CodeInvalidName, "name must be a DNS label."))
				}
			}
			if raw, ok := n.With["resource"]; ok {
				m, ok := raw.(map[string]any)
				if !ok {
					errs = append(errs, fieldError(path+".with.resource", n.pos.Line, n.pos.Column, CodeInvalidType, "resource must be a mapping with kind and name."))
				} else if k, _ := m["kind"].(string); k != "" && !kubernetes.ObservableKind(k) {
					errs = append(errs, fieldError(path+".with.resource.kind", n.pos.Line, n.pos.Column, CodeInvalidWith, "kind must be Deployment, StatefulSet, DaemonSet, or Job."))
				}
			}
		}
		if n.Type == "kubernetes.get" {
			if raw, ok := n.With["name"]; ok {
				s, ok := raw.(string)
				if !ok || !validDNSLabel(s) {
					errs = append(errs, fieldError(path+".with.name", n.pos.Line, n.pos.Column, CodeInvalidName, "name must be a DNS label."))
				}
			}
		}
		if n.Type == "kubernetes.apply" {
			if raw, ok := n.With["manifests"]; ok {
				s, ok := raw.(string)
				if !ok {
					errs = append(errs, fieldError(path+".with.manifests", n.pos.Line, n.pos.Column, CodeInvalidType, "manifests must be a string."))
				} else if looksLikeSecretManifest(s) {
					errs = append(errs, fieldError(path+".with.manifests", n.pos.Line, n.pos.Column, CodeSecretForbidden, "Secret manifests are not allowed in workflow YAML."))
				} else if templateRE.MatchString(s) {
					errs = append(errs, fieldError(path+".with.manifests", n.pos.Line, n.pos.Column, CodeTemplateForbidden, "Manifest templating is not allowed."))
				}
			}
		}
	case "ssh.run":
		errs = append(errs, validateTimeout(n.With, path)...)
		if params, ok := n.With["parameters"]; ok {
			if _, ok := params.(map[string]any); !ok {
				errs = append(errs, fieldError(path+".with.parameters", n.pos.Line, n.pos.Column, CodeInvalidType, "parameters must be a mapping."))
			}
		}
		if rp, ok := n.With["retryPolicy"]; ok {
			m, ok := rp.(map[string]any)
			if !ok {
				errs = append(errs, fieldError(path+".with.retryPolicy", n.pos.Line, n.pos.Column, CodeInvalidType, "retryPolicy must be a mapping."))
			} else if v, ok := m["maxAttempts"]; ok {
				if !isBoundedInt(v, 0, 5) {
					errs = append(errs, fieldError(path+".with.retryPolicy.maxAttempts", n.pos.Line, n.pos.Column, CodeInvalidWith, "retryPolicy.maxAttempts must be between 0 and 5."))
				}
			}
			// Omitted maxAttempts defaults to 0 (no retries). Profile retrySafe
			// + verification are enforced at pin/publish against the catalog.
		}
	case "script.python", "script.go":
		errs = append(errs, validateTimeout(n.With, path)...)
		errs = append(errs, validateScriptNode(n, path)...)
	case "http.request":
		if v, ok := n.With["method"]; ok {
			s, ok := v.(string)
			if !ok || !oneOf(strings.ToUpper(s), "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD") {
				errs = append(errs, fieldError(path+".with.method", n.pos.Line, n.pos.Column, CodeInvalidWith, "method must be an allowlisted HTTP verb."))
			}
		}
		if v, ok := n.With["path"]; ok {
			s, ok := v.(string)
			if !ok || !httpPathRE.MatchString(s) || strings.Contains(s, "://") {
				errs = append(errs, fieldError(path+".with.path", n.pos.Line, n.pos.Column, CodeUnsafeReference, "path must be a relative URL path, not a full URL."))
			}
		}
		errs = append(errs, validateTimeout(n.With, path)...)
	case "flow.approval":
		if v, ok := n.With["expiresIn"]; ok {
			s, ok := v.(string)
			if !ok || !validISODuration(s) {
				errs = append(errs, fieldError(path+".with.expiresIn", n.pos.Line, n.pos.Column, CodeInvalidWith, "expiresIn must be an ISO-8601 duration."))
			}
		}
		if v, ok := n.With["approverRole"]; ok {
			s, ok := v.(string)
			if !ok || strings.TrimSpace(s) == "" {
				errs = append(errs, fieldError(path+".with.approverRole", n.pos.Line, n.pos.Column, CodeInvalidType, "approverRole must be a string."))
			}
		}
	}
	return errs
}

func validateScriptNode(n Node, path string) ErrorList {
	var errs ErrorList
	lang := "python"
	if n.Type == "script.go" {
		lang = "go"
	}
	if v, ok := n.With["source"]; ok {
		s, ok := v.(string)
		if !ok {
			errs = append(errs, fieldError(path+".with.source", n.pos.Line, n.pos.Column, CodeInvalidType, "source must be a string."))
		} else {
			if err := scripts.ValidateSource(lang, s, stringField(n.With, "entrypoint")); err != nil {
				if ee := scriptsAsField(err, path+".with.source", n.pos.Line, n.pos.Column); ee.Code != CodeInvalidEntrypoint {
					errs = append(errs, ee)
				}
			}
			if err := scripts.ScanSource(s); err != nil {
				errs = append(errs, scriptsAsField(err, path+".with.source", n.pos.Line, n.pos.Column))
			}
		}
	}
	if v, ok := n.With["entrypoint"]; ok {
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" {
			errs = append(errs, fieldError(path+".with.entrypoint", n.pos.Line, n.pos.Column, CodeInvalidType, "entrypoint must be a non-empty string."))
		} else if err := scripts.ValidateEntrypoint(lang, s); err != nil {
			errs = append(errs, scriptsAsField(err, path+".with.entrypoint", n.pos.Line, n.pos.Column))
		}
	}
	if v, ok := n.With["memoryMiB"]; ok && !isBoundedInt(v, 32, 2048) {
		errs = append(errs, fieldError(path+".with.memoryMiB", n.pos.Line, n.pos.Column, CodeInvalidWith, "memoryMiB must be between 32 and 2048."))
	}
	if v, ok := n.With["cpuMillis"]; ok && !isBoundedInt(v, 1, 8000) {
		errs = append(errs, fieldError(path+".with.cpuMillis", n.pos.Line, n.pos.Column, CodeInvalidWith, "cpuMillis must be between 1 and 8000."))
	}
	if v, ok := n.With["processes"]; ok && !isBoundedInt(v, 1, 256) {
		errs = append(errs, fieldError(path+".with.processes", n.pos.Line, n.pos.Column, CodeInvalidWith, "processes must be between 1 and 256."))
	}
	for _, key := range []string{"inputSchema", "outputSchema"} {
		raw, ok := n.With[key]
		if !ok {
			continue
		}
		schema, ok := raw.(map[string]any)
		if !ok {
			errs = append(errs, fieldError(path+".with."+key, n.pos.Line, n.pos.Column, CodeInvalidType, key+" must be a mapping."))
			continue
		}
		errs = append(errs, ValidateDeclaredSchema(schema, path+".with."+key)...)
		if err := scripts.RequireObjectRoot(schema, key); err != nil {
			errs = append(errs, scriptsAsField(err, path+".with."+key, n.pos.Line, n.pos.Column))
		}
	}
	if err := scripts.ValidateRetryDeclaration(n.With); err != nil {
		errs = append(errs, scriptsAsField(err, path+".with", n.pos.Line, n.pos.Column))
	}
	if rp, ok := n.With["retryPolicy"]; ok {
		m, ok := rp.(map[string]any)
		if !ok {
			errs = append(errs, fieldError(path+".with.retryPolicy", n.pos.Line, n.pos.Column, CodeInvalidType, "retryPolicy must be a mapping."))
		} else if v, ok := m["maxAttempts"]; ok {
			if !isBoundedInt(v, 0, 5) {
				errs = append(errs, fieldError(path+".with.retryPolicy.maxAttempts", n.pos.Line, n.pos.Column, CodeInvalidWith, "retryPolicy.maxAttempts must be between 0 and 5."))
			}
		}
	}
	return errs
}

func stringField(with map[string]any, key string) string {
	s, _ := with[key].(string)
	return s
}

func scriptsAsField(err error, path string, line, column int) FieldError {
	var ee *scripts.EngineError
	if errors.As(err, &ee) && ee != nil {
		code := ee.Code
		switch code {
		case scripts.CodeInvalidEntrypoint:
			code = CodeInvalidEntrypoint
		case scripts.CodeInvalidSource:
			code = CodeInvalidSource
		case scripts.CodeSecretForbidden:
			code = CodeSecretForbidden
		case scripts.CodeSizeLimit:
			code = CodeOutputTooLarge
		case scripts.CodeInvalidSchema:
			code = CodeInvalidSchema
		case scripts.CodeRetryDenied:
			code = CodeRetryDenied
		case scripts.CodeInvalidVerification:
			code = CodeInvalidVerification
		}
		return fieldError(path, line, column, code, ee.Message)
	}
	return fieldError(path, line, column, CodeInvalidWith, "script configuration is not valid.")
}

func validateTimeout(with map[string]any, path string) ErrorList {
	v, ok := with["timeoutSeconds"]
	if !ok {
		return nil
	}
	if !isBoundedInt(v, 1, 3600) {
		return ErrorList{fieldError(path+".with.timeoutSeconds", 0, 0, CodeInvalidWith, "timeoutSeconds must be between 1 and 3600.")}
	}
	return nil
}

func validateEdgePorts(doc *Document, e Edge, from, to PortRef, path string) ErrorList {
	var errs ErrorList
	fromIdx, fromOK := nodeIndex(doc, from.NodeID)
	if !fromOK {
		errs = append(errs, fieldError(path+".from", e.pos.Line, e.pos.Column, CodeUnresolvedReference, fmt.Sprintf("Edge references unknown node %q.", from.NodeID)))
	}
	toIdx, toOK := nodeIndex(doc, to.NodeID)
	if !toOK {
		errs = append(errs, fieldError(path+".to", e.pos.Line, e.pos.Column, CodeUnresolvedReference, fmt.Sprintf("Edge references unknown node %q.", to.NodeID)))
	}
	if from.NodeID == to.NodeID && fromOK {
		errs = append(errs, fieldError(path, e.pos.Line, e.pos.Column, CodeCycle, "An edge cannot connect a node to itself."))
	}
	if !fromOK || !toOK {
		return errs
	}
	fromType, fromKnown := lookupNode(doc.Spec.Nodes[fromIdx].Type)
	toType, toKnown := lookupNode(doc.Spec.Nodes[toIdx].Type)
	if !fromKnown || !toKnown || fromType.Phase != PhaseCore || toType.Phase != PhaseCore {
		return errs
	}
	out, ok := fromType.outputPort(from.Port)
	if !ok {
		errs = append(errs, fieldError(path+".from", e.pos.Line, e.pos.Column, CodeInvalidPort, fmt.Sprintf("Node type %q has no output port %q.", fromType.Type, from.Port)))
		return errs
	}
	in, ok := toType.inputPort(to.Port)
	if !ok {
		errs = append(errs, fieldError(path+".to", e.pos.Line, e.pos.Column, CodeInvalidPort, fmt.Sprintf("Node type %q has no input port %q.", toType.Type, to.Port)))
		return errs
	}
	if !Compatible(out, in) {
		errs = append(errs, fieldError(path, e.pos.Line, e.pos.Column, CodeIncompatiblePorts, fmt.Sprintf("Port %s (%s) is not compatible with %s (%s).", e.From, out.Kind, e.To, in.Kind)))
	}
	return errs
}

func validateGraph(doc *Document, nodesByID map[string]int) ErrorList {
	var errs ErrorList
	if len(doc.Spec.Nodes) == 0 {
		return errs
	}

	// Required inputs must be satisfied by an incoming edge or node.inputs
	// (or, for some types, a matching with field).
	incoming := map[string]bool{}
	adj := map[string][]string{}
	undirected := map[string][]string{}
	for _, e := range doc.Spec.Edges {
		from, fromOK := parsePortRef(e.From)
		to, toOK := parsePortRef(e.To)
		if !fromOK || !toOK {
			continue
		}
		if _, ok := nodesByID[from.NodeID]; !ok {
			continue
		}
		if _, ok := nodesByID[to.NodeID]; !ok {
			continue
		}
		incoming[e.To] = true
		adj[from.NodeID] = append(adj[from.NodeID], to.NodeID)
		undirected[from.NodeID] = append(undirected[from.NodeID], to.NodeID)
		undirected[to.NodeID] = append(undirected[to.NodeID], from.NodeID)
	}

	for i, n := range doc.Spec.Nodes {
		nt, ok := lookupNode(n.Type)
		if !ok || nt.Phase != PhaseCore {
			continue
		}
		path := fmt.Sprintf("spec.nodes[%d]", i)
		for _, p := range nt.Inputs {
			if !p.Required {
				continue
			}
			wired := incoming[n.ID+"."+p.Name]
			if _, hasInput := n.Inputs[p.Name]; hasInput {
				wired = true
			}
			if n.Type == "kubernetes.rolloutStatus" && p.Name == "resource" {
				if _, ok := n.With["resource"]; ok {
					wired = true
				}
			}
			if !wired {
				errs = append(errs, fieldError(path+".inputs."+p.Name, n.pos.Line, n.pos.Column, CodeRequiredInput, fmt.Sprintf("Required input %s.%s is not wired.", n.ID, p.Name)))
			}
		}
	}

	if cycle, path := directedCycle(doc.Spec.Nodes, adj); cycle {
		errs = append(errs, fieldError("spec.edges", 0, 0, CodeCycle, fmt.Sprintf("Workflow graph contains a cycle (%s).", strings.Join(path, " -> "))))
	}

	if len(doc.Spec.Nodes) > 1 {
		start := doc.Spec.Nodes[0].ID
		seen := map[string]bool{}
		queue := []string{start}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			if seen[cur] {
				continue
			}
			seen[cur] = true
			queue = append(queue, undirected[cur]...)
		}
		for i, n := range doc.Spec.Nodes {
			if !seen[n.ID] {
				errs = append(errs, fieldError(fmt.Sprintf("spec.nodes[%d].id", i), n.pos.Line, n.pos.Column, CodeDisconnectedNode, fmt.Sprintf("Node %q is disconnected from the workflow graph.", n.ID)))
			}
		}
	}
	return errs
}

func directedCycle(nodes []Node, adj map[string][]string) (bool, []string) {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := map[string]int{}
	parent := map[string]string{}
	var cycle []string
	var found bool
	var visit func(string)
	visit = func(u string) {
		if found {
			return
		}
		color[u] = gray
		for _, v := range adj[u] {
			if found {
				return
			}
			if color[v] == white {
				parent[v] = u
				visit(v)
			} else if color[v] == gray {
				found = true
				cycle = []string{u}
				for x := parent[u]; x != "" && x != v; x = parent[x] {
					cycle = append([]string{x}, cycle...)
				}
				cycle = append([]string{v}, cycle...)
				cycle = append(cycle, v)
				return
			}
		}
		color[u] = black
	}
	for _, n := range nodes {
		if color[n.ID] == white {
			visit(n.ID)
		}
	}
	return found, cycle
}

func nodeIndex(doc *Document, id string) (int, bool) {
	for i, n := range doc.Spec.Nodes {
		if n.ID == id {
			return i, true
		}
	}
	return 0, false
}

func scanUnsafe(v any, path string) ErrorList {
	var errs ErrorList
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			childPath := joinPath(path, k)
			if unsafeKeyRE.MatchString(k) {
				errs = append(errs, fieldError(childPath, 0, 0, CodeUnsafeReference, "Secret or credential fields are not allowed in workflow YAML."))
				continue
			}
			if resourceUUIDFields[k] {
				if s, ok := child.(string); ok && !validUUID(s) {
					errs = append(errs, fieldError(childPath, 0, 0, CodeInvalidUUID, k+" must be a workspace-scoped UUID."))
				}
			}
			errs = append(errs, scanUnsafe(child, childPath)...)
		}
	case []any:
		for i, child := range t {
			errs = append(errs, scanUnsafe(child, indexPath(path, i))...)
		}
	case string:
		if pemOrTokenRE.MatchString(t) {
			errs = append(errs, fieldError(path, 0, 0, CodeSecretForbidden, "Secret material is not allowed in workflow YAML."))
		}
	}
	return errs
}

func looksLikeSecretManifest(src string) bool {
	// Cheap closed check: reject Secret documents before the Kubernetes engine exists.
	for _, doc := range strings.Split(src, "\n---") {
		kindSecret := false
		hasSecretData := false
		for _, line := range strings.Split(doc, "\n") {
			trim := strings.TrimSpace(line)
			if trim == "kind: Secret" || strings.HasPrefix(trim, "kind: Secret") {
				kindSecret = true
			}
			if strings.HasPrefix(trim, "stringData:") || strings.HasPrefix(trim, "data:") || strings.HasPrefix(trim, "binaryData:") {
				hasSecretData = true
			}
		}
		if kindSecret || (hasSecretData && strings.Contains(doc, "Secret")) {
			return true
		}
	}
	return false
}

func validLabelKey(k string) bool {
	if validDNSLabel(k) {
		return true
	}
	if prefix, name, ok := strings.Cut(k, "/"); ok {
		return validDNSLabel(strings.ReplaceAll(prefix, ".", "-")) && validDNSLabel(name)
	}
	return false
}

func validISODuration(s string) bool {
	if s == "" || s[0] != 'P' {
		return false
	}
	rest := s[1:]
	if rest == "" {
		return false
	}
	date, timePart, found := strings.Cut(rest, "T")
	if !consumeDurationUnits(date, "YMWD") {
		return false
	}
	if found {
		if timePart == "" || !consumeDurationUnits(timePart, "HMS") {
			return false
		}
	}
	return date != "" || found
}

func consumeDurationUnits(s, units string) bool {
	if s == "" {
		return true
	}
	i := 0
	seen := 0
	for i < len(s) {
		start := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if i == start || i >= len(s) {
			return false
		}
		idx := strings.IndexByte(units, s[i])
		if idx < 0 || idx < seen {
			return false
		}
		seen = idx + 1
		i++
	}
	return true
}

func oneOf(v string, opts ...string) bool {
	for _, o := range opts {
		if v == o {
			return true
		}
	}
	return false
}

func isBoundedInt(v any, min, max int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	case uint64:
		return n <= uint64(max) && int64(n) >= min
	default:
		return false
	}
}
