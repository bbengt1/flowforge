package wfstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const redactedMarker = "[redacted]"

var secretKeyPart = regexp.MustCompile(`(?i)(password|passwd|secret|token|authorization|credential|api[_-]?key|private[_-]?key|kubeconfig|ciphertext|dek[_-]?envelope|bearer)`)

// RedactValue returns a JSON-safe copy with secret keys and secret-shaped
// strings replaced before persistence or API echo.
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
	case string:
		if looksLikeSecret(t) {
			return redactedMarker
		}
		return t
	default:
		return v
	}
}

func shouldRedactKey(key string) bool {
	k := normalizeKey(key)
	switch k {
	case "authorization", "cookie", "set_cookie", "password", "passwd",
		"secret", "token", "access_token", "refresh_token", "id_token",
		"api_key", "apikey", "x_api_key", "database_url", "dsn",
		"credential", "credentials", "private_key", "client_secret",
		"webhook_secret", "kubeconfig", "dek_envelope", "ciphertext",
		"credential_kek":
		return true
	}
	return secretKeyPart.MatchString(k)
}

func normalizeKey(key string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(key)), "-", "_")
}

func looksLikeSecret(s string) bool {
	if s == "" {
		return false
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "bearer ") {
		return true
	}
	if strings.Contains(s, "BEGIN ") && strings.Contains(s, "PRIVATE KEY") {
		return true
	}
	return false
}

func redactObject(v map[string]any) map[string]any {
	if v == nil {
		return map[string]any{}
	}
	out, _ := RedactValue(v).(map[string]any)
	if out == nil {
		return map[string]any{}
	}
	return out
}

func cloneObject(v map[string]any) map[string]any {
	if v == nil {
		return map[string]any{}
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func canonicalJSON(v any) ([]byte, error) {
	return json.Marshal(canonicalize(v))
}

func canonicalize(v any) any {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(keys))
		for _, k := range keys {
			out[k] = canonicalize(t[k])
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = canonicalize(child)
		}
		return out
	default:
		return t
	}
}

func fingerprintIdempotency(workspaceID, versionID, actorID, triggerID string, input map[string]any) (string, error) {
	payload := map[string]any{
		"workspaceId": workspaceID,
		"versionId":   versionID,
		"actorId":     actorID,
		"triggerId":   strings.TrimSpace(triggerID),
		"input":       canonicalize(input),
	}
	raw, err := canonicalJSON(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

var idempotencyKeyRE = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,128}$`)

func validateIdempotencyKey(key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	if !idempotencyKeyRE.MatchString(key) {
		return ErrIdempotencyKeyInvalid
	}
	return nil
}

func boundInput(input map[string]any) (map[string]any, error) {
	if input == nil {
		return map[string]any{}, nil
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, ErrInvalid
	}
	if len(raw) > MaxExecutionInputBytes {
		return nil, ErrInvalid
	}
	return cloneObject(input), nil
}

func listLimit(n int) int {
	if n <= 0 {
		return DefaultListLimit
	}
	if n > MaxListLimit {
		return MaxListLimit
	}
	return n
}

func marshalObject(v map[string]any) ([]byte, error) {
	if v == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(v)
}

func unmarshalObject(raw []byte) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

type plannedNode struct {
	ID   string
	Type string
	Name string
	With map[string]any
}

func planNodes(yamlDoc string, summary workflow.Summary) []plannedNode {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) == 0 && res != nil && res.Document != nil && len(res.Document.Spec.Nodes) > 0 {
		out := make([]plannedNode, 0, len(res.Document.Spec.Nodes))
		for _, n := range res.Document.Spec.Nodes {
			out = append(out, plannedNode{ID: n.ID, Type: n.Type, Name: n.Name, With: n.With})
		}
		return out
	}
	out := make([]plannedNode, 0, len(summary.Nodes))
	for _, n := range summary.Nodes {
		out = append(out, plannedNode{ID: n.ID, Type: n.Type, Name: n.Name})
	}
	return out
}

func isActiveExecution(status string) bool {
	switch status {
	case ExecutionQueued, ExecutionPinned, ExecutionRunning:
		return true
	default:
		return false
	}
}

// BoundStep truncates redacted output/error maps for API responses.
func BoundStep(step ExecutionStep) ExecutionStep {
	out, truncated := boundObject(step.Output, MaxStepOutputBytes)
	step.Output = out
	errObj, errTrunc := boundObject(step.Error, MaxStepOutputBytes)
	step.Error = errObj
	step.OutputTruncated = truncated || errTrunc
	return step
}

func BoundSteps(steps []ExecutionStep) []ExecutionStep {
	if steps == nil {
		return []ExecutionStep{}
	}
	out := make([]ExecutionStep, len(steps))
	for i, step := range steps {
		out[i] = BoundStep(step)
	}
	return out
}

func boundObject(v map[string]any, maxBytes int) (map[string]any, bool) {
	if v == nil {
		return map[string]any{}, false
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}, false
	}
	if len(raw) <= maxBytes {
		return cloneObject(v), false
	}
	return map[string]any{
		"truncated": true,
		"summary":   "output exceeded the API bound and was omitted",
		"bytes":     len(raw),
	}, true
}

func isTerminalExecution(status string) bool {
	switch status {
	case ExecutionSucceeded, ExecutionFailed, ExecutionCanceled, ExecutionIndeterminate, ExecutionPinned:
		return true
	default:
		return false
	}
}
