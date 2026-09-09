package scripts

import (
	"net"
	"net/http"
	"strconv"
	"strings"
)

// Cloud metadata and link-local identities that runners must never reach.
var metadataDestinations = []string{
	"169.254.169.254",
	"169.254.170.2",
	"fd00:ec2::254",
	"metadata.google.internal",
	"metadata.google.com",
}

var metadataCIDRs = []string{
	"169.254.169.254/32",
	"169.254.170.2/32",
	"169.254.0.0/16",
	"fd00:ec2::254/128",
}

// EgressRule is one approved destination. Empty policy is default-deny.
type EgressRule struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol,omitempty"`
}

// EgressPolicy is the runner network contract. DNS is constrained to the
// allowlisted hosts; metadata and the Docker socket are never allowed.
type EgressPolicy struct {
	Destinations   []EgressRule `json:"destinations"`
	DNSConstrained bool         `json:"dnsConstrained"`
}

// DefaultDenyEgress is the MVP network policy: no destinations.
func DefaultDenyEgress() EgressPolicy {
	return EgressPolicy{Destinations: nil, DNSConstrained: true}
}

// ParseEgressPolicy reads optional runtime_profile.egress.
func ParseEgressPolicy(raw map[string]any) (EgressPolicy, error) {
	out := DefaultDenyEgress()
	if raw == nil {
		return out, nil
	}
	if v, ok := raw["dnsConstrained"].(bool); ok {
		out.DNSConstrained = v
	}
	if !out.DNSConstrained {
		return EgressPolicy{}, engineError(CodeEgressDenied, "unconstrained DNS is denied.", http.StatusForbidden)
	}
	items, _ := raw["destinations"].([]any)
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			return EgressPolicy{}, engineError(CodeEgressDenied, "egress.destinations entries must be objects.", http.StatusBadRequest)
		}
		host, _ := m["host"].(string)
		host = strings.ToLower(strings.TrimSpace(host))
		if host == "" {
			return EgressPolicy{}, engineError(CodeEgressDenied, "egress destination host is required.", http.StatusBadRequest)
		}
		port := 443
		if n, ok := asInt(m["port"]); ok {
			port = n
		}
		proto, _ := m["protocol"].(string)
		proto = strings.ToLower(strings.TrimSpace(proto))
		if proto == "" {
			proto = "tcp"
		}
		rule := EgressRule{Host: host, Port: port, Protocol: proto}
		if err := validateEgressRule(rule); err != nil {
			return EgressPolicy{}, err
		}
		out.Destinations = append(out.Destinations, rule)
	}
	return out, ValidateEgressPolicy(out)
}

// ValidateEgressPolicy rejects metadata, wildcards, and unconstrained DNS.
func ValidateEgressPolicy(policy EgressPolicy) error {
	if !policy.DNSConstrained {
		return engineError(CodeEgressDenied, "unconstrained DNS is denied.", http.StatusForbidden)
	}
	for _, rule := range policy.Destinations {
		if err := validateEgressRule(rule); err != nil {
			return err
		}
	}
	return nil
}

func validateEgressRule(rule EgressRule) error {
	host := strings.ToLower(strings.TrimSpace(rule.Host))
	if host == "" || host == "*" || host == "0.0.0.0" || host == "::" || host == "localhost" || host == "127.0.0.1" {
		return engineError(CodeEgressDenied, "wildcard, loopback, and empty egress hosts are denied.", http.StatusForbidden)
	}
	if rule.Port < 1 || rule.Port > 65535 {
		return engineError(CodeEgressDenied, "egress port is out of range.", http.StatusBadRequest)
	}
	if isMetadataHost(host) {
		return engineError(CodeMetadataDenied, "cloud instance metadata destinations cannot be allowlisted.", http.StatusForbidden)
	}
	if isDockerSocketHost(host) {
		return engineError(CodeDockerSocketDenied, "the Docker socket cannot be an egress destination.", http.StatusForbidden)
	}
	return nil
}

// EvaluateEgress is default-deny. Metadata is denied even if listed.
func EvaluateEgress(policy EgressPolicy, host string, port int) error {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return engineError(CodeEgressDenied, "egress destination is required.", http.StatusForbidden)
	}
	if isMetadataHost(host) {
		return ErrMetadataDenied
	}
	if isDockerSocketHost(host) {
		return engineError(CodeDockerSocketDenied, "the host Docker socket is denied.", http.StatusForbidden)
	}
	if err := ValidateEgressPolicy(policy); err != nil {
		return err
	}
	for _, rule := range policy.Destinations {
		if strings.EqualFold(rule.Host, host) && (port == 0 || rule.Port == port) {
			if policy.DNSConstrained && !dnsAllowed(host, policy) {
				return engineError(CodeEgressDenied, "DNS resolution is constrained to allowlisted destinations.", http.StatusForbidden)
			}
			return nil
		}
	}
	return ErrEgressDenied
}

func dnsAllowed(host string, policy EgressPolicy) bool {
	for _, rule := range policy.Destinations {
		if strings.EqualFold(rule.Host, host) {
			return true
		}
	}
	return false
}

func isMetadataHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return false
	}
	if ip := net.ParseIP(h); ip != nil {
		for _, cidr := range metadataCIDRs {
			_, n, err := net.ParseCIDR(cidr)
			if err == nil && n.Contains(ip) {
				return true
			}
		}
	}
	for _, blocked := range metadataDestinations {
		if h == blocked {
			return true
		}
	}
	return strings.Contains(h, "metadata.google") || strings.HasPrefix(h, "169.254.")
}

func isDockerSocketHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	return strings.Contains(h, "docker.sock") || h == "docker" || strings.HasSuffix(h, "/var/run/docker.sock")
}

// MetadataCIDRs is the Chloe/catalog list of blocked link-local ranges.
func MetadataCIDRs() []string {
	return append([]string(nil), metadataCIDRs...)
}

func egressHostPort(target string) (string, int) {
	target = strings.TrimSpace(target)
	if host, port, err := net.SplitHostPort(target); err == nil {
		n, _ := strconv.Atoi(port)
		return host, n
	}
	return target, 0
}
