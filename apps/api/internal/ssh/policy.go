package ssh

import (
	"net/http"
	"strings"
)

// Canonical evaluation keys for kind=ssh policies.
const (
	KeyAllowedHosts     = "allowedHosts"
	KeyHosts            = "hosts"
	KeyAllowedAddresses = "allowedAddresses"
	KeyAddresses        = "addresses"
	KeyDeny             = "deny"
	KeyRequireApproval  = "requireApproval"
	KeyApproverRole     = "approverRole"
	KeyExpiresIn        = "expiresIn"
	KeyOperations       = "operations"
)

// SSHPolicyKeys is the closed set of keys for kind=ssh.
func SSHPolicyKeys() []string {
	return []string{
		KeyAllowedHosts, KeyHosts,
		KeyAllowedAddresses, KeyAddresses,
		KeyDeny, KeyRequireApproval, KeyApproverRole, KeyExpiresIn, KeyOperations,
	}
}

// EvaluationKey describes a documented policy field and its aliases.
type EvaluationKey struct {
	Canonical             string   `json:"canonical"`
	Aliases               []string `json:"aliases"`
	FailClosedWhenPresent bool     `json:"failClosedWhenPresent"`
	RequiredForPublish    bool     `json:"requiredForPublish"`
}

// EvaluationKeys is the UI/engine vocabulary for SSH policy.
func EvaluationKeys() []EvaluationKey {
	return []EvaluationKey{
		{Canonical: KeyAllowedHosts, Aliases: []string{KeyAllowedHosts, KeyHosts}, FailClosedWhenPresent: true},
		{Canonical: KeyAllowedAddresses, Aliases: []string{KeyAllowedAddresses, KeyAddresses}, FailClosedWhenPresent: true},
		{Canonical: KeyDeny, Aliases: []string{KeyDeny}},
		{Canonical: KeyRequireApproval, Aliases: []string{KeyRequireApproval}},
		{Canonical: KeyApproverRole, Aliases: []string{KeyApproverRole}},
		{Canonical: KeyExpiresIn, Aliases: []string{KeyExpiresIn}},
		{Canonical: KeyOperations, Aliases: []string{KeyOperations}, FailClosedWhenPresent: true},
	}
}

// Hosts is the host allowlist (canonical or alias).
func Hosts(rules map[string]any) ([]string, bool) {
	return allowlist(rules, KeyAllowedHosts, KeyHosts)
}

// Addresses is the address allowlist (canonical or alias).
func Addresses(rules map[string]any) ([]string, bool) {
	return allowlist(rules, KeyAllowedAddresses, KeyAddresses)
}

func allowlist(rules map[string]any, keys ...string) ([]string, bool) {
	if rules == nil {
		return nil, false
	}
	for _, key := range keys {
		raw, ok := rules[key]
		if !ok || raw == nil {
			continue
		}
		return stringSlice(rules, key), true
	}
	return nil, false
}

// Allowed reports whether got is in items. An empty present list denies.
func Allowed(items []string, got string) bool {
	got = strings.TrimSpace(got)
	if got == "" || len(items) == 0 {
		return false
	}
	for _, item := range items {
		if strings.EqualFold(item, got) {
			return true
		}
	}
	return false
}

// PolicyContext is the authorization snapshot revalidated before connect.
type PolicyContext struct {
	Deny              bool
	Hosts             []string
	HostsPresent      bool
	Addresses         []string
	AddressesPresent  bool
	Operations        []string
	OperationsPresent bool
	Revision          string
	Digest            string
}

// TargetContext is the pinned SSH target used for host/address checks.
type TargetContext struct {
	ID               string
	Hostname         string
	Port             int
	Username         string
	HostKeySHA256    string
	AllowedAddresses []string
	AddressesPresent bool
	CredentialID     string
}

// ProfileContext is the pinned command-profile revision.
type ProfileContext struct {
	ID        string
	Revision  string
	Digest    string
	RetrySafe bool
	Template  string
	Schema    *ParameterSchema
	Spec      map[string]any
}

// PolicyContextFromRules builds a PolicyContext from a kind=ssh policy object.
func PolicyContextFromRules(rules map[string]any) PolicyContext {
	hosts, hostsPresent := Hosts(rules)
	addrs, addrsPresent := Addresses(rules)
	ops, opsPresent := allowlist(rules, KeyOperations)
	deny, _ := rules[KeyDeny].(bool)
	return PolicyContext{
		Deny:              deny,
		Hosts:             hosts,
		HostsPresent:      hostsPresent,
		Addresses:         addrs,
		AddressesPresent:  addrsPresent,
		Operations:        ops,
		OperationsPresent: opsPresent,
		Revision:          "",
		Digest:            "",
	}
}

// TargetContextFromSpec builds a TargetContext from an ssh_target spec.
func TargetContextFromSpec(id string, spec map[string]any) TargetContext {
	if spec == nil {
		spec = map[string]any{}
	}
	host, _ := spec["hostname"].(string)
	fp, _ := spec["hostKeyFingerprint"].(string)
	cred, _ := spec["credentialId"].(string)
	user, _ := spec["username"].(string)
	port := 22
	if n, err := asInt(spec["port"]); err == nil && n > 0 {
		port = n
	}
	addrs, present := allowlist(spec, KeyAllowedAddresses)
	return TargetContext{
		ID:               strings.TrimSpace(id),
		Hostname:         strings.TrimSpace(host),
		Port:             port,
		Username:         strings.TrimSpace(user),
		HostKeySHA256:    strings.TrimSpace(fp),
		AllowedAddresses: addrs,
		AddressesPresent: present,
		CredentialID:     strings.TrimSpace(cred),
	}
}

// ProfileContextFromSpec builds a ProfileContext from a command_profile spec.
func ProfileContextFromSpec(id string, spec map[string]any) ProfileContext {
	if spec == nil {
		spec = map[string]any{}
	}
	retry, _ := spec["retrySafe"].(bool)
	tmpl, _ := spec["template"].(string)
	ctx := ProfileContext{
		ID:        strings.TrimSpace(id),
		RetrySafe: retry,
		Template:  tmpl,
		Spec:      spec,
	}
	if raw, ok := spec["parameterSchema"].(map[string]any); ok {
		if schema, err := ParseSchema(raw); err == nil {
			ctx.Schema = schema
		}
	}
	return ctx
}

// ValidatePolicy re-checks deny, host, address, and operation allowlists
// immediately before connect. Present empty lists fail closed.
func ValidatePolicy(policy PolicyContext, target TargetContext, username string) *EngineError {
	if policy.Deny {
		return engineError(CodePolicyDenied, "SSH policy denies this operation", http.StatusForbidden)
	}
	if policy.OperationsPresent {
		if !Allowed(policy.Operations, NodeSSHRun) && !Allowed(policy.Operations, VerbRun) {
			return engineError(CodePolicyDenied, "operation is not allowed by policy", http.StatusForbidden)
		}
	}
	if policy.HostsPresent {
		if !Allowed(policy.Hosts, target.Hostname) {
			return engineError(CodePolicyDenied, "host is not allowed by policy", http.StatusForbidden)
		}
	}
	_ = username
	return nil
}

func stringSlice(m map[string]any, key string) []string {
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
