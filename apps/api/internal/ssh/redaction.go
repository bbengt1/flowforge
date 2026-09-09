package ssh

import (
	"regexp"
	"strings"
)

const redactedMarker = "[redacted]"

var secretKeyPart = regexp.MustCompile(`(?i)(password|passwd|secret|token|authorization|credential|api[_-]?key|private[_-]?key|passphrase|kubeconfig|ciphertext|bearer)`)

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
		"token", "authorization", "kubeconfig", "command":
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
	if strings.Contains(lower, "kubeconfig") {
		return true
	}
	if strings.HasPrefix(lower, "bearer ") {
		return true
	}
	return false
}

func boundText(s string, max int) (string, bool) {
	if max <= 0 {
		max = MaxStdoutBytes
	}
	if len(s) <= max {
		return s, false
	}
	return s[:max], true
}

func redactText(s string) string {
	if looksLikeSecretString(s) {
		return redactedMarker
	}
	return s
}
