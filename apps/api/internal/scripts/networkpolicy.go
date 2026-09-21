package scripts

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

// Script Job NetworkPolicy name. The production runner reads this object
// in the Job namespace and refuses to create a Job when it is missing or
// broader than DNS plus the configured control-plane API.
const ScriptRunnerNetworkPolicyName = "flowforge-script-runner"

// Deploy-config env for the control-plane API (claim, progress, complete).
// Values are read by the runner process. They are not baked into the
// script-runner image.
const (
	EnvControlPlaneCIDR             = "CONTROL_PLANE_API_CIDR"
	EnvControlPlanePort             = "CONTROL_PLANE_API_PORT"
	EnvControlPlaneService          = "CONTROL_PLANE_API_SERVICE"
	EnvControlPlaneServiceNamespace = "CONTROL_PLANE_API_SERVICE_NAMESPACE"
	EnvSkipScriptNetworkPolicy      = "SCRIPT_RUNNER_SKIP_NETWORK_POLICY"
)

// ErrControlPlaneMissing means neither a CIDR nor a Service was configured.
var ErrControlPlaneMissing = errors.New("control-plane API CIDR or Service is missing")

// ErrControlPlaneInvalid means the CIDR or Service config is present and rejected.
var ErrControlPlaneInvalid = errors.New("control-plane API CIDR or Service is invalid")

// ControlPlaneConfig is the only destination a script Job may reach besides DNS.
// Set CIDR, or Service plus ServiceNamespace. Port defaults to 443.
// Selector is filled from the Service before policy validation in Service mode.
type ControlPlaneConfig struct {
	CIDR             string
	Port             int
	Service          string
	ServiceNamespace string
	Selector         map[string]string
}

// ParseControlPlaneEnv reads deploy config. A missing destination returns
// ErrControlPlaneMissing. A world CIDR, hostname, or half-set Service returns
// ErrControlPlaneInvalid. The caller refuses to create script Jobs in either case.
func ParseControlPlaneEnv(cidr, port, service, namespace string) (ControlPlaneConfig, error) {
	parsedPort, err := parseControlPlanePort(port)
	if err != nil {
		return ControlPlaneConfig{}, err
	}
	return normalizeControlPlane(ControlPlaneConfig{
		CIDR:             cidr,
		Port:             parsedPort,
		Service:          service,
		ServiceNamespace: namespace,
	})
}

func normalizeControlPlane(cfg ControlPlaneConfig) (ControlPlaneConfig, error) {
	cfg.CIDR = strings.TrimSpace(cfg.CIDR)
	cfg.Service = strings.TrimSpace(cfg.Service)
	cfg.ServiceNamespace = strings.TrimSpace(cfg.ServiceNamespace)
	if cfg.Port == 0 {
		cfg.Port = 443
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return ControlPlaneConfig{}, ErrControlPlaneInvalid
	}
	hasCIDR := cfg.CIDR != ""
	hasService := cfg.Service != "" || cfg.ServiceNamespace != ""
	if hasCIDR && hasService {
		return ControlPlaneConfig{}, ErrControlPlaneInvalid
	}
	if !hasCIDR && !hasService {
		return ControlPlaneConfig{}, ErrControlPlaneMissing
	}
	if hasCIDR {
		if err := rejectControlPlaneCIDR(cfg.CIDR); err != nil {
			return ControlPlaneConfig{}, err
		}
		cfg.Service = ""
		cfg.ServiceNamespace = ""
		cfg.Selector = nil
		return cfg, nil
	}
	if cfg.Service == "" || cfg.ServiceNamespace == "" || !validJobNamespace(cfg.Service) || !validJobNamespace(cfg.ServiceNamespace) {
		return ControlPlaneConfig{}, ErrControlPlaneInvalid
	}
	return cfg, nil
}

func parseControlPlanePort(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 443, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 65535 {
		return 0, ErrControlPlaneInvalid
	}
	return n, nil
}

func rejectControlPlaneCIDR(cidr string) error {
	p, err := netip.ParsePrefix(cidr)
	if err != nil || p.Bits() == 0 || p != p.Masked() || p.String() != cidr {
		return ErrControlPlaneInvalid
	}
	if p.Addr().IsUnspecified() || p.Addr().IsMulticast() {
		return ErrControlPlaneInvalid
	}
	return nil
}

// NetworkPolicyDenied refuses a script Job before any create call.
type NetworkPolicyDenied struct{}

// Submit returns network-policy-denied and does not create a Job.
func (NetworkPolicyDenied) Submit(context.Context, map[string]any) (IsolatedResult, error) {
	return IsolatedResult{}, networkPolicyUnconfigured()
}

func networkPolicyUnconfigured() error {
	return engineError(CodeNetworkPolicyDenied, "script Job network policy is not configured; refusing to create the Job.", http.StatusForbidden)
}

func networkPolicyDenied() error {
	return engineError(CodeNetworkPolicyDenied, "script Job network policy is missing or does not restrict egress to DNS and the control-plane API.", http.StatusForbidden)
}

// ValidateScriptNetworkPolicy accepts only default-deny ingress plus two
// egress peers: kube-system DNS (UDP/TCP 53) and the configured control-plane
// API. Any other peer, a world CIDR, or a missing policy fails closed.
func ValidateScriptNetworkPolicy(obj map[string]any, cfg ControlPlaneConfig) error {
	cfg, err := normalizeControlPlane(cfg)
	if err != nil {
		return networkPolicyDenied()
	}
	if obj["kind"] != "NetworkPolicy" || obj["apiVersion"] != "networking.k8s.io/v1" {
		return networkPolicyDenied()
	}
	meta, _ := obj["metadata"].(map[string]any)
	name, _ := meta["name"].(string)
	if name != ScriptRunnerNetworkPolicyName {
		return networkPolicyDenied()
	}
	spec, _ := obj["spec"].(map[string]any)
	if spec == nil || !scriptPodSelector(spec["podSelector"]) {
		return networkPolicyDenied()
	}
	if !exactPolicyTypes(spec["policyTypes"]) {
		return networkPolicyDenied()
	}
	if ingress, ok := spec["ingress"]; ok {
		rules, _ := ingress.([]any)
		if len(rules) != 0 {
			return networkPolicyDenied()
		}
	}
	egress, _ := spec["egress"].([]any)
	if len(egress) != 2 {
		return networkPolicyDenied()
	}
	var sawDNS, sawAPI bool
	for _, item := range egress {
		rule, _ := item.(map[string]any)
		switch {
		case isDNSEgress(rule):
			sawDNS = true
		case isControlPlaneEgress(rule, cfg):
			sawAPI = true
		default:
			return networkPolicyDenied()
		}
	}
	if !sawDNS || !sawAPI {
		return networkPolicyDenied()
	}
	return nil
}

func scriptPodSelector(raw any) bool {
	sel, _ := raw.(map[string]any)
	labels, _ := sel["matchLabels"].(map[string]any)
	if !labelIs(labels, "app.kubernetes.io/name", "flowforge") || !labelIs(labels, "app.kubernetes.io/component", "script-runner") {
		return false
	}
	if _, open := sel["matchExpressions"]; open {
		return false
	}
	return true
}

func exactPolicyTypes(raw any) bool {
	list, _ := raw.([]any)
	if len(list) != 2 {
		return false
	}
	seen := map[string]bool{}
	for _, item := range list {
		s, _ := item.(string)
		seen[s] = true
	}
	return seen["Ingress"] && seen["Egress"]
}

func isDNSEgress(rule map[string]any) bool {
	peers, ok := objectPeers(rule["to"])
	if !ok || len(peers) != 1 || !onlyKeys(peers[0], "namespaceSelector") {
		return false
	}
	ns, _ := peers[0]["namespaceSelector"].(map[string]any)
	labels, _ := ns["matchLabels"].(map[string]any)
	if len(labels) != 1 || !labelIs(labels, "kubernetes.io/metadata.name", "kube-system") {
		return false
	}
	if _, open := ns["matchExpressions"]; open {
		return false
	}
	return exactPorts(rule["ports"], map[string]int{"UDP": 53, "TCP": 53})
}

func isControlPlaneEgress(rule map[string]any, cfg ControlPlaneConfig) bool {
	peers, ok := objectPeers(rule["to"])
	if !ok || len(peers) != 1 {
		return false
	}
	peer := peers[0]
	if cfg.CIDR != "" {
		if !onlyKeys(peer, "ipBlock") {
			return false
		}
		block, _ := peer["ipBlock"].(map[string]any)
		if !onlyKeys(block, "cidr") {
			return false
		}
		cidr, _ := block["cidr"].(string)
		if !samePrefix(cidr, cfg.CIDR) {
			return false
		}
		return exactPorts(rule["ports"], map[string]int{"TCP": cfg.Port})
	}
	if !onlyKeys(peer, "namespaceSelector", "podSelector") || len(cfg.Selector) == 0 {
		return false
	}
	ns, _ := peer["namespaceSelector"].(map[string]any)
	nsLabels, _ := ns["matchLabels"].(map[string]any)
	if len(nsLabels) != 1 || !labelIs(nsLabels, "kubernetes.io/metadata.name", cfg.ServiceNamespace) {
		return false
	}
	pod, _ := peer["podSelector"].(map[string]any)
	podLabels, _ := pod["matchLabels"].(map[string]any)
	if _, open := pod["matchExpressions"]; open {
		return false
	}
	if _, open := ns["matchExpressions"]; open {
		return false
	}
	if len(podLabels) != len(cfg.Selector) {
		return false
	}
	for k, want := range cfg.Selector {
		if !labelIs(podLabels, k, want) {
			return false
		}
	}
	return exactPorts(rule["ports"], map[string]int{"TCP": cfg.Port})
}

func objectPeers(raw any) ([]map[string]any, bool) {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return nil, false
	}
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok || len(m) == 0 {
			return nil, false
		}
		out = append(out, m)
	}
	return out, true
}

func exactPorts(raw any, want map[string]int) bool {
	list, ok := raw.([]any)
	if !ok || len(list) != len(want) {
		return false
	}
	seen := map[string]int{}
	for _, item := range list {
		m, _ := item.(map[string]any)
		if !onlyKeys(m, "protocol", "port") {
			return false
		}
		proto, _ := m["protocol"].(string)
		port, ok := asInt(m["port"])
		if !ok || proto == "" {
			return false
		}
		seen[proto] = port
	}
	if len(seen) != len(want) {
		return false
	}
	for proto, port := range want {
		if seen[proto] != port {
			return false
		}
	}
	return true
}

func onlyKeys(m map[string]any, keys ...string) bool {
	if len(m) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := m[key]; !ok {
			return false
		}
	}
	return true
}

func labelIs(labels map[string]any, key, want string) bool {
	got, _ := labels[key].(string)
	return got == want
}

func samePrefix(got, want string) bool {
	a, errA := netip.ParsePrefix(strings.TrimSpace(got))
	b, errB := netip.ParsePrefix(strings.TrimSpace(want))
	if errA != nil || errB != nil || a.Bits() == 0 || b.Bits() == 0 {
		return false
	}
	return a == b
}

func serviceSelector(obj map[string]any) (map[string]string, error) {
	spec, _ := obj["spec"].(map[string]any)
	raw, _ := spec["selector"].(map[string]any)
	if len(raw) == 0 {
		return nil, networkPolicyDenied()
	}
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		s, ok := v.(string)
		if !ok || strings.TrimSpace(k) == "" || strings.TrimSpace(s) == "" {
			return nil, networkPolicyDenied()
		}
		out[k] = s
	}
	return out, nil
}
