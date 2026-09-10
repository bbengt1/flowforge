package httpnotify

import (
	"encoding/json"
	"regexp"
	"strings"
)

const (
	redactedMarker     = "[redacted]"
	minTrackedSecretLen = 4
)

var secretKeyPart = regexp.MustCompile(`(?i)(password|passwd|secret|token|authorization|credential|api[_-]?key|private[_-]?key|passphrase|kubeconfig|ciphertext|bearer|smtp)`)

// SecretFieldAuthorized reports whether a named request field may carry a
// secret. Connection endpointPolicy.secretFields is the only allowlist.
func SecretFieldAuthorized(policy EndpointPolicy, field string) bool {
	field = strings.TrimSpace(field)
	if field == "" {
		return false
	}
	for _, allowed := range policy.SecretFields {
		if strings.EqualFold(strings.TrimSpace(allowed), field) {
			return true
		}
	}
	return false
}

// RejectUnauthorizedSecrets fails closed when payload keys look secret and
// are not on the connection secret-field allowlist.
func RejectUnauthorizedSecrets(payload map[string]any, policy EndpointPolicy) *EngineError {
	return walkSecrets(payload, "", policy)
}

func walkSecrets(v any, path string, policy EndpointPolicy) *EngineError {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			field := k
			if path != "" {
				field = path + "." + k
			}
			if shouldRedactKey(k) && !SecretFieldAuthorized(policy, k) && !SecretFieldAuthorized(policy, field) {
				return engineError(CodeSecretDenied, "secret-bearing field is not authorized by the connection policy", 403)
			}
			if err := walkSecrets(child, field, policy); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range t {
			if err := walkSecrets(child, path, policy); err != nil {
				return err
			}
		}
	}
	return nil
}

// CollectSecretValues records request/credential secret strings so echoed
// values can be scrubbed even when they appear under innocuous keys.
func CollectSecretValues(payload map[string]any, policy EndpointPolicy, extras ...string) []string {
	seen := map[string]struct{}{}
	var out []string
	var add func(string)
	add = func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
		lower := strings.ToLower(s)
		if strings.HasPrefix(lower, "bearer ") {
			add(strings.TrimSpace(s[7:]))
		}
	}
	for _, extra := range extras {
		add(extra)
	}
	collectSecretWalk(payload, "", policy, add)
	return out
}

func collectSecretWalk(v any, path string, policy EndpointPolicy, add func(string)) {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			field := k
			if path != "" {
				field = path + "." + k
			}
			if shouldRedactKey(k) || SecretFieldAuthorized(policy, k) || SecretFieldAuthorized(policy, field) {
				if s, ok := child.(string); ok {
					add(s)
				}
			}
			collectSecretWalk(child, field, policy, add)
		}
	case []any:
		for _, child := range t {
			collectSecretWalk(child, path, policy, add)
		}
	case string:
		if looksLikeSecretString(t) {
			add(t)
		}
	}
}

// RedactValue strips secret-shaped keys and known secret values from outputs.
func RedactValue(v any, secrets ...string) any {
	return redactValue(v, secrets, 0)
}

func redactValue(v any, secrets []string, depth int) any {
	if depth > 16 || v == nil {
		return v
	}
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			if shouldRedactKey(k) {
				out[k] = redactedMarker
				continue
			}
			out[k] = redactValue(child, secrets, depth+1)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = redactValue(child, secrets, depth+1)
		}
		return out
	case []string:
		out := make([]string, len(t))
		for i, child := range t {
			out[i] = redactSecretString(child, secrets)
		}
		return out
	case string:
		return redactSecretString(t, secrets)
	default:
		return v
	}
}

func redactSecretString(s string, secrets []string) string {
	if looksLikeSecretString(s) {
		return redactedMarker
	}
	for _, secret := range secrets {
		if secret != "" && s == secret {
			return redactedMarker
		}
	}
	for _, secret := range secrets {
		if len(secret) >= minTrackedSecretLen && strings.Contains(s, secret) {
			s = strings.ReplaceAll(s, secret, redactedMarker)
		}
	}
	return s
}

func shouldRedactKey(key string) bool {
	k := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(key)), "-", "_")
	switch k {
	case "privatekey", "private_key", "passphrase", "password", "secret",
		"token", "authorization", "kubeconfig", "cookie", "set_cookie":
		return true
	}
	return secretKeyPart.MatchString(k)
}

func looksLikeSecretString(s string) bool {
	if s == "" {
		return false
	}
	lower := strings.ToLower(s)
	if strings.Contains(lower, "-----begin ") || strings.Contains(lower, "private key") {
		return true
	}
	if strings.HasPrefix(lower, "bearer ") {
		return true
	}
	return false
}

func boundBytes(b []byte, max int) ([]byte, bool) {
	if max <= 0 {
		max = DefaultMaxResponseBytes
	}
	if len(b) <= max {
		return b, false
	}
	return b[:max], true
}

func decodeJSONObject(raw []byte) (map[string]any, bool) {
	if len(raw) == 0 {
		return map[string]any{}, true
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, false
	}
	obj, ok := out.(map[string]any)
	if !ok {
		return map[string]any{"value": out}, true
	}
	return obj, true
}
