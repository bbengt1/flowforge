package httpnotify

import (
	"net/http"
	"strings"
)

// Canonical evaluation keys for kind=http and kind=notification policies.
const (
	KeyAllowedHosts             = "allowedHosts"
	KeyHosts                    = "hosts"
	KeyAllowedAddresses         = "allowedAddresses"
	KeyAddresses                = "addresses"
	KeyAllowPrivateDestinations = "allowPrivateDestinations"
	KeyDeny                     = "deny"
	KeyRequireApproval          = "requireApproval"
	KeyApproverRole             = "approverRole"
	KeyExpiresIn                = "expiresIn"
	KeyOperations               = "operations"
)

// HTTPPolicyKeys is the closed set for kind=http and kind=notification.
func HTTPPolicyKeys() []string {
	return []string{
		KeyAllowedHosts, KeyHosts,
		KeyAllowedAddresses, KeyAddresses,
		KeyAllowPrivateDestinations,
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

// EvaluationKeys is the UI/engine vocabulary for http/notification policy.
func EvaluationKeys() []EvaluationKey {
	return []EvaluationKey{
		{Canonical: KeyAllowedHosts, Aliases: []string{KeyAllowedHosts, KeyHosts}, FailClosedWhenPresent: true},
		{Canonical: KeyAllowedAddresses, Aliases: []string{KeyAllowedAddresses, KeyAddresses}, FailClosedWhenPresent: true},
		{Canonical: KeyAllowPrivateDestinations, Aliases: []string{KeyAllowPrivateDestinations}, FailClosedWhenPresent: true},
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

// PolicyContext is the authorization snapshot revalidated before delivery.
type PolicyContext struct {
	Kind                     string
	Deny                     bool
	Hosts                    []string
	HostsPresent             bool
	Addresses                []string
	AddressesPresent         bool
	AllowPrivateDestinations bool
	Operations               []string
	OperationsPresent        bool
	Revision                 string
	Digest                   string
}

// PolicyContextFromRules builds a PolicyContext from a kind=http|notification object.
func PolicyContextFromRules(kind string, rules map[string]any) PolicyContext {
	if rules == nil {
		rules = map[string]any{}
	}
	hosts, hostsPresent := Hosts(rules)
	addrs, addrsPresent := Addresses(rules)
	ops, opsPresent := allowlist(rules, KeyOperations)
	deny, _ := rules[KeyDeny].(bool)
	allowPrivate, _ := rules[KeyAllowPrivateDestinations].(bool)
	return PolicyContext{
		Kind:                     strings.TrimSpace(kind),
		Deny:                     deny,
		Hosts:                    hosts,
		HostsPresent:             hostsPresent,
		Addresses:                addrs,
		AddressesPresent:         addrsPresent,
		AllowPrivateDestinations: allowPrivate,
		Operations:               ops,
		OperationsPresent:        opsPresent,
	}
}

// ValidatePolicy re-checks deny, host, address, and operation allowlists
// immediately before delivery. Present empty lists fail closed.
func ValidatePolicy(policy PolicyContext, op, host string, addrs []string) *EngineError {
	if policy.Deny {
		return engineError(CodePolicyDenied, "policy denies this operation", http.StatusForbidden)
	}
	if policy.Kind != "" {
		switch policy.Kind {
		case "http":
			if op != NodeHTTPRequest {
				return engineError(CodePolicyDenied, "policy kind does not match the requested operation", http.StatusForbidden)
			}
		case "notification":
			if op != NodeWebhook && op != NodeEmail {
				return engineError(CodePolicyDenied, "policy kind does not match the requested operation", http.StatusForbidden)
			}
		case "approval":
		default:
			return engineError(CodePolicyDenied, "policy kind does not match the requested operation", http.StatusForbidden)
		}
	}
	if policy.OperationsPresent {
		if !Allowed(policy.Operations, op) {
			return engineError(CodePolicyDenied, "operation is not allowed by policy", http.StatusForbidden)
		}
	}
	if policy.HostsPresent && host != "" {
		if !Allowed(policy.Hosts, host) {
			return engineError(CodePolicyDenied, "host is not allowed by policy", http.StatusForbidden)
		}
	}
	if policy.AddressesPresent {
		if len(policy.Addresses) == 0 {
			return engineError(CodeEmptyAllowlist, "A present address allowlist was empty (fail closed).", http.StatusBadRequest)
		}
		if len(addrs) == 0 {
			return engineError(CodePolicyDenied, "destination addresses are not allowed by policy", http.StatusForbidden)
		}
		for _, addr := range addrs {
			if !AddressAllowed(policy.Addresses, parseIP(addr)) && !Allowed(policy.Addresses, addr) {
				return engineError(CodePolicyDenied, "a destination address is not allowed by policy", http.StatusForbidden)
			}
		}
	}
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
