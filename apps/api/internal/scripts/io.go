package scripts

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

var secretInputKeys = map[string]bool{
	"password": true, "passwd": true, "secret": true, "token": true,
	"privatekey": true, "private_key": true, "passphrase": true,
	"kubeconfig": true, "credential": true, "authorization": true,
	"bearer": true, "apikey": true, "api_key": true, "accesskey": true,
	"access_key": true, "clientsecret": true, "client_secret": true,
}

// ValidateExecutionInput checks declared inputSchema, size limits, and
// secret material before anything is injected into the runner.
func ValidateExecutionInput(input map[string]any, schema map[string]any) error {
	if input == nil {
		input = map[string]any{}
	}
	if err := rejectPersistedSecrets(input, "input"); err != nil {
		return err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return engineError(CodeInputRejected, "input must be JSON-serializable.", http.StatusBadRequest)
	}
	if len(raw) > MaxInputBytes {
		return engineError(CodeSizeLimit, fmt.Sprintf("input exceeds the %d byte limit.", MaxInputBytes), http.StatusBadRequest)
	}
	if schema != nil {
		if err := ValidateDeclaredSchema(schema, "inputSchema"); err != nil {
			return err
		}
		if err := RequireObjectRoot(schema, "inputSchema"); err != nil {
			return err
		}
		if err := validateValueAgainstSchema(input, schema, "input"); err != nil {
			return err
		}
	}
	return nil
}

// ValidateExecutionOutput parses runner stdout, enforces outputSchema and
// size limits, and redacts secret-shaped tokens before persist/audit.
func ValidateExecutionOutput(stdout string, schema map[string]any) (map[string]any, string, error) {
	if irredactableSecret([]byte(stdout)) {
		return nil, "", engineError(CodeSecretForbidden, "Secret material is not allowed in script output.", http.StatusBadRequest)
	}
	safe := RedactSource(stdout)
	if len(safe) > MaxOutputBytes {
		return nil, "", engineError(CodeOutputTooLarge, fmt.Sprintf("output exceeds the %d byte limit.", MaxOutputBytes), http.StatusBadRequest)
	}
	trimmed := strings.TrimSpace(safe)
	if trimmed == "" {
		if schema == nil {
			return map[string]any{}, safe, nil
		}
		return nil, safe, engineError(CodeInvalidSchema, "output is empty and does not match outputSchema.", http.StatusBadRequest)
	}
	var parsed any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		if schema == nil {
			return map[string]any{"stdout": safe}, safe, nil
		}
		return nil, safe, engineError(CodeInvalidSchema, "output must be JSON matching outputSchema.", http.StatusBadRequest)
	}
	if err := rejectPersistedSecrets(parsed, "output"); err != nil {
		return nil, "", err
	}
	if schema != nil {
		if err := ValidateDeclaredSchema(schema, "outputSchema"); err != nil {
			return nil, safe, err
		}
		if err := RequireObjectRoot(schema, "outputSchema"); err != nil {
			return nil, safe, err
		}
		if err := validateValueAgainstSchema(parsed, schema, "output"); err != nil {
			return nil, safe, err
		}
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return nil, safe, engineError(CodeInvalidSchema, "output must be JSON-serializable.", http.StatusBadRequest)
	}
	if len(encoded) > MaxOutputBytes {
		return nil, "", engineError(CodeOutputTooLarge, fmt.Sprintf("output exceeds the %d byte limit.", MaxOutputBytes), http.StatusBadRequest)
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		if schema != nil {
			return nil, safe, engineError(CodeInvalidSchema, "output must be a JSON object matching outputSchema.", http.StatusBadRequest)
		}
		return map[string]any{"stdout": safe}, safe, nil
	}
	return obj, string(encoded), nil
}

func rejectPersistedSecrets(v any, path string) error {
	switch n := v.(type) {
	case map[string]any:
		for k, child := range n {
			childPath := path + "." + k
			if secretInputKeys[strings.ToLower(strings.ReplaceAll(k, "-", ""))] {
				return engineError(CodeSecretForbidden, "Secret keys are not allowed in persisted script I/O.", http.StatusBadRequest)
			}
			if err := rejectPersistedSecrets(child, childPath); err != nil {
				return err
			}
		}
	case []any:
		for i, child := range n {
			if err := rejectPersistedSecrets(child, fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	case string:
		if irredactableSecret([]byte(n)) {
			return engineError(CodeSecretForbidden, "Secret material is not allowed in persisted script I/O.", http.StatusBadRequest)
		}
		if _, changed := redactTokens(n); changed {
			return engineError(CodeSecretForbidden, "Secret material is not allowed in persisted script I/O.", http.StatusBadRequest)
		}
	}
	return nil
}

func validateValueAgainstSchema(value any, schema map[string]any, path string) error {
	if schema == nil {
		return nil
	}
	if raw, ok := schema["classification"].(string); ok && strings.EqualFold(raw, "secret") {
		return &EngineError{Code: CodeSecretForbidden, Message: "Secret classification is not allowed on script I/O.", Status: http.StatusBadRequest, Path: path}
	}
	if encoded, err := json.Marshal(value); err == nil && len(encoded) > MaxInputBytes {
		return engineError(CodeSizeLimit, fmt.Sprintf("%s exceeds the byte limit.", path), http.StatusBadRequest)
	}
	if typ, ok := schema["type"].(string); ok && !valueMatchesType(value, typ) {
		return &EngineError{Code: CodeInvalidSchema, Message: fmt.Sprintf("Value is not a %s.", typ), Status: http.StatusBadRequest, Path: path}
	}
	if raw, ok := schema["enum"].([]any); ok {
		found := false
		for _, item := range raw {
			if valuesEqual(item, value) {
				found = true
				break
			}
		}
		if !found {
			return &EngineError{Code: CodeInvalidSchema, Message: "Value is not in the declared enum.", Status: http.StatusBadRequest, Path: path}
		}
	}
	if raw, ok := schema["maxLength"]; ok {
		if s, ok := value.(string); ok {
			if n, ok := asInt(raw); ok && len(s) > n {
				return &EngineError{Code: CodeInvalidSchema, Message: "String exceeds schema.maxLength.", Status: http.StatusBadRequest, Path: path}
			}
		}
	}
	if raw, ok := schema["minimum"]; ok {
		if n, ok := asFloat64(value); ok {
			if min, ok := asFloat64(raw); ok && n < min {
				return &EngineError{Code: CodeInvalidSchema, Message: "Value is below schema.minimum.", Status: http.StatusBadRequest, Path: path}
			}
		}
	}
	if raw, ok := schema["maximum"]; ok {
		if n, ok := asFloat64(value); ok {
			if max, ok := asFloat64(raw); ok && n > max {
				return &EngineError{Code: CodeInvalidSchema, Message: "Value is above schema.maximum.", Status: http.StatusBadRequest, Path: path}
			}
		}
	}
	if m, ok := value.(map[string]any); ok {
		if raw, ok := schema["maxProperties"]; ok {
			if n, ok := asInt(raw); ok && len(m) > n {
				return &EngineError{Code: CodeInvalidSchema, Message: "Object exceeds schema.maxProperties.", Status: http.StatusBadRequest, Path: path}
			}
		}
		props, _ := schema["properties"].(map[string]any)
		if raw, ok := schema["required"].([]any); ok {
			for _, item := range raw {
				name, _ := item.(string)
				if name == "" {
					continue
				}
				if _, exists := m[name]; !exists {
					return &EngineError{Code: CodeInvalidSchema, Message: fmt.Sprintf("Required field %q is missing.", name), Status: http.StatusBadRequest, Path: path + "." + name}
				}
			}
		}
		additional := true
		if raw, ok := schema["additionalProperties"].(bool); ok {
			additional = raw
		}
		for k, child := range m {
			childPath := path + "." + k
			if secretInputKeys[strings.ToLower(strings.ReplaceAll(k, "-", ""))] {
				return &EngineError{Code: CodeSecretForbidden, Message: "Secret-classified keys are not allowed.", Status: http.StatusBadRequest, Path: childPath}
			}
			if props != nil {
				if ps, ok := props[k].(map[string]any); ok {
					if err := validateValueAgainstSchema(child, ps, childPath); err != nil {
						return err
					}
					continue
				}
			}
			if !additional {
				return &EngineError{Code: CodeInvalidSchema, Message: fmt.Sprintf("Unknown field %q is not declared in the schema.", k), Status: http.StatusBadRequest, Path: childPath}
			}
		}
	}
	if list, ok := value.([]any); ok {
		if raw, ok := schema["maxItems"]; ok {
			if n, ok := asInt(raw); ok && len(list) > n {
				return &EngineError{Code: CodeInvalidSchema, Message: "Array exceeds schema.maxItems.", Status: http.StatusBadRequest, Path: path}
			}
		}
		if items, ok := schema["items"].(map[string]any); ok {
			for i, child := range list {
				if err := validateValueAgainstSchema(child, items, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func valueMatchesType(v any, typ string) bool {
	switch typ {
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "integer":
		_, ok := asInt(v)
		return ok
	case "number":
		_, ok := asFloat64(v)
		return ok
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "array":
		_, ok := v.([]any)
		return ok
	default:
		return true
	}
}

func valuesEqual(a, b any) bool {
	left, err1 := json.Marshal(a)
	right, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return string(left) == string(right)
}

func asFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}
