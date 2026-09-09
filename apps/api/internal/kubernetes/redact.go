package kubernetes

import (
	"regexp"
	"strings"
)

const redactedMarker = "[redacted]"

var secretKeyPart = regexp.MustCompile(`(?i)(password|passwd|secret|token|authorization|credential|api[_-]?key|private[_-]?key|kubeconfig|ciphertext|bearer)`)

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
	case Unstructured:
		return redactValue(map[string]any(t), depth)
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = redactValue(child, depth+1)
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
	case "kubeconfig", "token", "secret", "password", "authorization",
		"data", "string_data", "stringdata", "binary_data", "binarydata",
		"client_key_data", "client_certificate_data", "certificate_authority_data":
		return true
	}
	return secretKeyPart.MatchString(k)
}

func looksLikeSecretString(s string) bool {
	if s == "" {
		return false
	}
	lower := strings.ToLower(s)
	if strings.Contains(lower, "kubeconfig") || strings.Contains(lower, "-----begin ") {
		return true
	}
	if strings.HasPrefix(lower, "bearer ") {
		return true
	}
	return false
}

func redactObject(obj Unstructured) map[string]any {
	if obj == nil {
		return nil
	}
	v, _ := redactValue(map[string]any(obj), 0).(map[string]any)
	return v
}
