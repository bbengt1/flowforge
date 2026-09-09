package kubernetes

import "strings"

// Canonical evaluation keys accepted on policy.policy for kind=kubernetes.
// Aliases match E4.3 so existing drafts keep working.
const (
	KeyAllowedNamespaces   = "allowedNamespaces"
	KeyNamespaces          = "namespaces"
	KeyAllowedKinds        = "allowedKinds"
	KeyKinds               = "kinds"
	KeyAllowedVerbs        = "allowedVerbs"
	KeyVerbs               = "verbs"
	KeyAllowedImages       = "allowedImages"
	KeyImages              = "images"
	KeyAllowedIngressHosts = "allowedIngressHosts"
	KeyIngressHosts        = "ingressHosts"
	KeyDeny                = "deny"
	KeyRequireApproval     = "requireApproval"
	KeyApproverRole        = "approverRole"
	KeyExpiresIn           = "expiresIn"
	KeyOperations          = "operations"
)

// KubernetesPolicyKeys is the closed set of keys for kind=kubernetes.
func KubernetesPolicyKeys() []string {
	return []string{
		KeyAllowedNamespaces, KeyNamespaces,
		KeyAllowedKinds, KeyKinds,
		KeyAllowedVerbs, KeyVerbs,
		KeyAllowedImages, KeyImages,
		KeyAllowedIngressHosts, KeyIngressHosts,
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

// EvaluationKeys is the UI/engine vocabulary for Kubernetes policy.
func EvaluationKeys() []EvaluationKey {
	return []EvaluationKey{
		{Canonical: KeyAllowedNamespaces, Aliases: []string{KeyAllowedNamespaces, KeyNamespaces}, FailClosedWhenPresent: true, RequiredForPublish: true},
		{Canonical: KeyAllowedKinds, Aliases: []string{KeyAllowedKinds, KeyKinds}, FailClosedWhenPresent: true},
		{Canonical: KeyAllowedVerbs, Aliases: []string{KeyAllowedVerbs, KeyVerbs}, FailClosedWhenPresent: true},
		{Canonical: KeyAllowedImages, Aliases: []string{KeyAllowedImages, KeyImages}, FailClosedWhenPresent: true},
		{Canonical: KeyAllowedIngressHosts, Aliases: []string{KeyAllowedIngressHosts, KeyIngressHosts}, FailClosedWhenPresent: true},
		{Canonical: KeyDeny, Aliases: []string{KeyDeny}},
		{Canonical: KeyRequireApproval, Aliases: []string{KeyRequireApproval}},
		{Canonical: KeyApproverRole, Aliases: []string{KeyApproverRole}},
		{Canonical: KeyExpiresIn, Aliases: []string{KeyExpiresIn}},
		{Canonical: KeyOperations, Aliases: []string{KeyOperations}, FailClosedWhenPresent: true},
	}
}

// Allowlist returns items and whether any alias key is present (including an
// empty array). Presence with no members is fail-closed.
func Allowlist(rules map[string]any, keys ...string) (items []string, present bool) {
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

// Namespaces is the namespace allowlist (canonical or alias).
func Namespaces(rules map[string]any) ([]string, bool) {
	return Allowlist(rules, KeyAllowedNamespaces, KeyNamespaces)
}

// Kinds is the kind allowlist (canonical or alias).
func Kinds(rules map[string]any) ([]string, bool) {
	return Allowlist(rules, KeyAllowedKinds, KeyKinds)
}

// Verbs is the verb allowlist (canonical or alias).
func Verbs(rules map[string]any) ([]string, bool) {
	return Allowlist(rules, KeyAllowedVerbs, KeyVerbs)
}

// Images is the digest-pinned image allowlist (canonical or alias).
func Images(rules map[string]any) ([]string, bool) {
	return Allowlist(rules, KeyAllowedImages, KeyImages)
}

// IngressHosts is the Ingress host allowlist (canonical or alias).
func IngressHosts(rules map[string]any) ([]string, bool) {
	return Allowlist(rules, KeyAllowedIngressHosts, KeyIngressHosts)
}

// Allowed reports whether got is in items. An empty present list denies.
func Allowed(items []string, got string) bool {
	got = strings.TrimSpace(got)
	if got == "" || len(items) == 0 {
		return false
	}
	return containsFold(items, got)
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
