package httpnotify

import (
	"encoding/json"
	"regexp"
	"strings"
)

const redactedMarker = "[redacted]"

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

// RedactValue strips secret-shaped keys and values from engine outputs.
func RedactValue(v any) any {
	return redactValue(v, 0)
}

func redactValue(v any, depth int) any {
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
			out[k] = redactValue(child, depth+1)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = redactValue(child, depth+1)
		}
		return out
	case []string:
		out := make([]string, len(t))
		for i, child := range t {
			if looksLikeSecretString(child) {
				out[i] = redactedMarker
			} else {
				out[i] = child
			}
		}
		return out
	case string:
		if looksLikeSecretString(t) {
			return redactedMarker
		}
		return t
	default:
		return v
	}
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
