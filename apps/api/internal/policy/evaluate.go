// Package policy evaluates target/action policy before dispatch and
// describes approval requirements bound to version, target, policy, and expiry.
package policy

import (
	"fmt"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Decision values for an evaluation or a single operation.
const (
	DecisionAllow            = "allow"
	DecisionDeny             = "deny"
	DecisionApprovalRequired = "approval-required"
)

const (
	defaultExpiresIn    = "PT1H"
	defaultApproverRole = "approver"
	maxExpiry           = 7 * 24 * time.Hour
)

// Requirement is a fail-closed approval binding produced before dispatch.
type Requirement struct {
	NodeID           string    `json:"nodeId"`
	NodeName         string    `json:"nodeName,omitempty"`
	Operation        string    `json:"operation"`
	TargetKind       string    `json:"targetKind,omitempty"`
	TargetID         string    `json:"targetId,omitempty"`
	TargetVersionID  string    `json:"targetVersionId,omitempty"`
	TargetDigest     string    `json:"targetDigest,omitempty"`
	PolicyResourceID string    `json:"policyResourceId,omitempty"`
	PolicyVersionID  string    `json:"policyVersionId,omitempty"`
	PolicyDigest     string    `json:"policyDigest,omitempty"`
	PolicyRevision   int       `json:"policyRevision,omitempty"`
	ApproverRole     string    `json:"approverRole"`
	ExpiresIn        string    `json:"expiresIn"`
	ExpiresAt        time.Time `json:"expiresAt"`
	Reason           string    `json:"reason,omitempty"`
}

// OperationResult is the per-node evaluation outcome.
type OperationResult struct {
	NodeID      string       `json:"nodeId"`
	Operation   string       `json:"operation"`
	Decision    string       `json:"decision"`
	Reason      string       `json:"reason,omitempty"`
	Requirement *Requirement `json:"requirement,omitempty"`
}

// Result is the workflow-level evaluation used by preview and dispatch.
type Result struct {
	Decision          string            `json:"decision"`
	DispatchAllowed   bool              `json:"dispatchAllowed"`
	Operations        []OperationResult `json:"operations"`
	Requirements      []Requirement     `json:"requirements"`
	Denied            []OperationResult `json:"denied"`
	EvaluatedAt       time.Time         `json:"evaluatedAt"`
	WorkflowVersionID string            `json:"workflowVersionId,omitempty"`
	WorkflowDigest    string            `json:"workflowDigest,omitempty"`
}

// Input is a parsed workflow plus current published pins for authorization.
type Input struct {
	YAML              string
	WorkflowVersionID string
	WorkflowDigest    string
	Pins              []opsconfig.Pin
	Now               time.Time
}

// Evaluate inspects each privileged node against the current published
// target/policy pins. Missing policy is allow (no extra constraint). A bound
// policy that does not authorize the action fails closed. flow.approval and
// requireApproval produce bound requirements.
func Evaluate(in Input) (Result, error) {
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	out := Result{
		Decision:          DecisionAllow,
		DispatchAllowed:   true,
		Operations:        []OperationResult{},
		Requirements:      []Requirement{},
		Denied:            []OperationResult{},
		EvaluatedAt:       now,
		WorkflowVersionID: strings.TrimSpace(in.WorkflowVersionID),
		WorkflowDigest:    strings.TrimSpace(in.WorkflowDigest),
	}
	res, errs := workflow.ParseAndNormalize([]byte(in.YAML))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return Result{}, fmt.Errorf("workflow definition is not valid")
	}
	pins := indexPins(in.Pins)
	for _, node := range res.Document.Spec.Nodes {
		op := strings.TrimSpace(node.Type)
		if !privilegedOperation(op) {
			continue
		}
		item := evaluateNode(node, pins, now)
		out.Operations = append(out.Operations, item)
		switch item.Decision {
		case DecisionDeny:
			out.Denied = append(out.Denied, item)
		case DecisionApprovalRequired:
			if item.Requirement != nil {
				out.Requirements = append(out.Requirements, *item.Requirement)
			}
		}
	}
	if len(out.Denied) > 0 {
		out.Decision = DecisionDeny
		out.DispatchAllowed = false
		return out, nil
	}
	if len(out.Requirements) > 0 {
		out.Decision = DecisionApprovalRequired
		out.DispatchAllowed = false
	}
	return out, nil
}

func evaluateNode(node workflow.Node, pins map[string]opsconfig.Pin, now time.Time) OperationResult {
	op := strings.TrimSpace(node.Type)
	item := OperationResult{NodeID: node.ID, Operation: op, Decision: DecisionAllow}
	targetKind, targetID := targetRef(node)
	var target opsconfig.Pin
	if targetID != "" {
		pin, ok := pins[targetID]
		if !ok {
			item.Decision = DecisionDeny
			item.Reason = "target is not a published revision in this workspace"
			return item
		}
		target = pin
		if targetKind == "" {
			targetKind = pin.Kind
		}
	}

	policyPin, policyReason, err := resolvePolicyPin(node, target, pins)
	if err != nil {
		item.Decision = DecisionDeny
		item.Reason = err.Error()
		return item
	}

	if op == "flow.approval" {
		req := requirementFromNode(node, target, policyPin, now, "flow.approval node requires a bound approval")
		item.Decision = DecisionApprovalRequired
		item.Reason = req.Reason
		item.Requirement = &req
		return item
	}

	if policyPin.VersionID == "" {
		return item
	}
	specKind, rules := policyRules(policyPin.Spec)
	if specKind != "" && specKind != "approval" && !policyApplies(specKind, op) {
		item.Decision = DecisionDeny
		item.Reason = "policy kind does not match the requested operation"
		return item
	}
	if boolField(rules, "deny") {
		item.Decision = DecisionDeny
		item.Reason = "policy denies this operation"
		return item
	}
	if reason := checkAllowlists(op, node, target, specKind, rules); reason != "" {
		item.Decision = DecisionDeny
		item.Reason = reason
		return item
	}
	if requiresApproval(specKind, rules, op) {
		reason := "policy requires approval before dispatch"
		if policyReason != "" {
			reason = policyReason
		}
		req := requirementFromPolicy(node, target, policyPin, rules, now, reason)
		item.Decision = DecisionApprovalRequired
		item.Reason = req.Reason
		item.Requirement = &req
		return item
	}
	return item
}

func resolvePolicyPin(node workflow.Node, target opsconfig.Pin, pins map[string]opsconfig.Pin) (opsconfig.Pin, string, error) {
	policyID := stringField(node.With, "policyId")
	if policyID == "" && target.Spec != nil {
		policyID = stringField(target.Spec, "policyId")
	}
	if policyID == "" {
		return opsconfig.Pin{}, "", nil
	}
	pin, ok := pins[policyID]
	if !ok {
		return opsconfig.Pin{}, "", fmt.Errorf("policy is not a published revision in this workspace")
	}
	if pin.Kind != opsconfig.KindPolicy {
		return opsconfig.Pin{}, "", fmt.Errorf("policyId must reference a policy")
	}
	return pin, "", nil
}

func requirementFromNode(node workflow.Node, target, policyPin opsconfig.Pin, now time.Time, reason string) Requirement {
	rules := map[string]any{}
	if policyPin.Spec != nil {
		_, rules = policyRules(policyPin.Spec)
	}
	expiresIn := stringField(node.With, "expiresIn")
	if expiresIn == "" {
		expiresIn = stringField(rules, "expiresIn")
	}
	role := stringField(node.With, "approverRole")
	if role == "" {
		role = stringField(rules, "approverRole")
	}
	return finishRequirement(node, target, policyPin, role, expiresIn, now, reason)
}

func requirementFromPolicy(node workflow.Node, target, policyPin opsconfig.Pin, rules map[string]any, now time.Time, reason string) Requirement {
	expiresIn := stringField(rules, "expiresIn")
	if expiresIn == "" {
		expiresIn = stringField(node.With, "expiresIn")
	}
	role := stringField(rules, "approverRole")
	if role == "" {
		role = stringField(node.With, "approverRole")
	}
	return finishRequirement(node, target, policyPin, role, expiresIn, now, reason)
}

func finishRequirement(node workflow.Node, target, policyPin opsconfig.Pin, role, expiresIn string, now time.Time, reason string) Requirement {
	if strings.TrimSpace(role) == "" {
		role = defaultApproverRole
	}
	if strings.TrimSpace(expiresIn) == "" {
		expiresIn = defaultExpiresIn
	}
	exp, err := workflow.ParseISODuration(expiresIn)
	if err != nil || exp <= 0 {
		exp = time.Hour
		expiresIn = defaultExpiresIn
	}
	if exp > maxExpiry {
		exp = maxExpiry
		expiresIn = "P7D"
	}
	return Requirement{
		NodeID:           node.ID,
		NodeName:         node.Name,
		Operation:        strings.TrimSpace(node.Type),
		TargetKind:       target.Kind,
		TargetID:         target.ResourceID,
		TargetVersionID:  target.VersionID,
		TargetDigest:     target.Digest,
		PolicyResourceID: policyPin.ResourceID,
		PolicyVersionID:  policyPin.VersionID,
		PolicyDigest:     policyPin.Digest,
		PolicyRevision:   policyPin.VersionNumber,
		ApproverRole:     strings.TrimSpace(role),
		ExpiresIn:        expiresIn,
		ExpiresAt:        now.Add(exp),
		Reason:           reason,
	}
}

func privilegedOperation(op string) bool {
	switch op {
	case "kubernetes.apply", "kubernetes.get", "kubernetes.list", "kubernetes.rolloutStatus",
		"ssh.run", "http.request", "notification.webhook", "notification.email",
		"script.python", "script.go", "flow.approval":
		return true
	default:
		return false
	}
}

func policyApplies(kind, op string) bool {
	switch kind {
	case "kubernetes":
		return strings.HasPrefix(op, "kubernetes.")
	case "ssh":
		return op == "ssh.run"
	case "http":
		return op == "http.request"
	case "notification":
		return strings.HasPrefix(op, "notification.")
	case "script":
		return strings.HasPrefix(op, "script.")
	case "approval":
		return true
	default:
		return false
	}
}

func requiresApproval(kind string, rules map[string]any, op string) bool {
	if kind == "approval" {
		return operationListed(rules, op)
	}
	if !boolField(rules, "requireApproval") {
		return false
	}
	return operationListed(rules, op)
}

func operationListed(rules map[string]any, op string) bool {
	listed := stringSlice(rules, "operations")
	if len(listed) == 0 {
		return true
	}
	for _, item := range listed {
		if item == op {
			return true
		}
	}
	return false
}

func checkAllowlists(op string, node workflow.Node, target opsconfig.Pin, kind string, rules map[string]any) string {
	ns := firstNonEmpty(stringSlice(rules, "allowedNamespaces"), stringSlice(rules, "namespaces"))
	if len(ns) > 0 {
		got := stringField(node.With, "namespace")
		if got == "" || !containsFold(ns, got) {
			return "namespace is not allowed by policy"
		}
	}
	kinds := firstNonEmpty(stringSlice(rules, "allowedKinds"), stringSlice(rules, "kinds"))
	if len(kinds) > 0 && strings.HasPrefix(op, "kubernetes.") {
		if !manifestKindAllowed(stringField(node.With, "manifests"), kinds) {
			return "resource kind is not allowed by policy"
		}
	}
	verbs := firstNonEmpty(stringSlice(rules, "allowedVerbs"), stringSlice(rules, "verbs"))
	if len(verbs) > 0 {
		if !containsFold(verbs, operationVerb(op)) {
			return "verb is not allowed by policy"
		}
	}
	hosts := firstNonEmpty(stringSlice(rules, "allowedHosts"), stringSlice(rules, "hosts"))
	if len(hosts) > 0 {
		host := stringField(node.With, "hostname")
		if host == "" && target.Spec != nil {
			host = stringField(target.Spec, "hostname")
		}
		if host == "" || !containsFold(hosts, host) {
			return "host is not allowed by policy"
		}
	}
	addrs := firstNonEmpty(stringSlice(rules, "allowedAddresses"), stringSlice(rules, "addresses"))
	if len(addrs) > 0 {
		host := stringField(target.Spec, "hostname")
		if host == "" || !containsFold(addrs, host) {
			return "address is not allowed by policy"
		}
	}
	_ = kind
	return ""
}

func operationVerb(op string) string {
	switch op {
	case "kubernetes.apply":
		return "apply"
	case "kubernetes.get", "kubernetes.rolloutStatus":
		return "get"
	case "kubernetes.list":
		return "list"
	case "ssh.run":
		return "run"
	default:
		if i := strings.LastIndex(op, "."); i >= 0 {
			return op[i+1:]
		}
		return op
	}
}

func manifestKindAllowed(manifests string, allowed []string) bool {
	if strings.TrimSpace(manifests) == "" {
		return true
	}
	found := false
	for _, line := range strings.Split(manifests, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "kind:") {
			continue
		}
		found = true
		kind := strings.TrimSpace(strings.TrimPrefix(line, "kind:"))
		if !containsFold(allowed, kind) {
			return false
		}
	}
	_ = found
	return true
}

func targetRef(node workflow.Node) (string, string) {
	for _, field := range []string{
		opsconfig.YAMLClusterTargetID, opsconfig.YAMLSSHTargetID, opsconfig.YAMLConnectionID,
		opsconfig.YAMLCommandProfileID, opsconfig.YAMLRuntimeProfileID,
	} {
		id := stringField(node.With, field)
		if id != "" {
			return opsconfig.YAMLFieldKind(field), id
		}
	}
	return "", ""
}

func policyRules(spec map[string]any) (string, map[string]any) {
	kind := stringField(spec, "kind")
	raw, _ := spec["policy"].(map[string]any)
	if raw == nil {
		raw = map[string]any{}
	}
	return kind, raw
}

func indexPins(pins []opsconfig.Pin) map[string]opsconfig.Pin {
	out := map[string]opsconfig.Pin{}
	for _, pin := range pins {
		if pin.ResourceID != "" {
			out[pin.ResourceID] = pin
		}
	}
	return out
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return strings.TrimSpace(s)
}

func boolField(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	b, _ := m[key].(bool)
	return b
}

func stringSlice(m map[string]any, key string) []string {
	if m == nil {
		return nil
	}
	raw, ok := m[key]
	if !ok || raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []string:
		out := make([]string, 0, len(v))
		for _, s := range v {
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			s, _ := item.(string)
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func firstNonEmpty(a, b []string) []string {
	if len(a) > 0 {
		return a
	}
	return b
}

func containsFold(items []string, want string) bool {
	want = strings.TrimSpace(want)
	for _, item := range items {
		if strings.EqualFold(item, want) {
			return true
		}
	}
	return false
}
