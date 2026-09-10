package httpnotify

import (
	"encoding/json"
	"strings"
)

const maxSchemaDepth = 16

// SchemaAllows reports whether value satisfies a pinned JSON-schema subset
// (type, required, properties, additionalProperties, enum, items, and
// numeric/string/object bounds). Empty or nil schemas allow any object.
func SchemaAllows(schema map[string]any, value any) bool {
	if len(schema) == 0 {
		return true
	}
	return schemaAllowsValue(schema, value, 0)
}

func schemaAllows(schema map[string]any, value map[string]any) bool {
	if value == nil {
		value = map[string]any{}
	}
	return SchemaAllows(schema, value)
}

func schemaAllowsValue(schema map[string]any, value any, depth int) bool {
	if schema == nil {
		return true
	}
	if depth > maxSchemaDepth {
		return false
	}
	if raw, exists := schema["type"]; exists {
		s, ok := raw.(string)
		if !ok || !knownSchemaType(s) || !valueMatchesSchemaType(value, s) {
			return false
		}
	}
	if raw, ok := schema["enum"]; ok {
		list, ok := asAnySlice(raw)
		if !ok {
			return false
		}
		found := false
		for _, item := range list {
			if valuesEqual(item, value) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if raw, ok := schema["maxLength"]; ok {
		if s, ok := value.(string); ok {
			if n, ok := asInt64(raw); ok && int64(len(s)) > n {
				return false
			}
		}
	}
	if raw, ok := schema["minimum"]; ok {
		if n, ok := asFloat64(value); ok {
			if min, ok := asFloat64(raw); ok && n < min {
				return false
			}
		}
	}
	if raw, ok := schema["maximum"]; ok {
		if n, ok := asFloat64(value); ok {
			if max, ok := asFloat64(raw); ok && n > max {
				return false
			}
		}
	}

	if m, ok := value.(map[string]any); ok {
		if raw, ok := schema["maxProperties"]; ok {
			if n, ok := asInt64(raw); ok && int64(len(m)) > n {
				return false
			}
		}
		for _, name := range stringAnyList(schema["required"]) {
			if _, exists := m[name]; !exists {
				return false
			}
		}
		props, _ := schema["properties"].(map[string]any)
		additional := true
		if raw, ok := schema["additionalProperties"].(bool); ok {
			additional = raw
		}
		for k, child := range m {
			if props != nil {
				if ps, ok := props[k].(map[string]any); ok {
					if !schemaAllowsValue(ps, child, depth+1) {
						return false
					}
					continue
				}
			}
			if !additional {
				return false
			}
		}
	}

	if list, ok := asAnySlice(value); ok {
		if raw, ok := schema["maxItems"]; ok {
			if n, ok := asInt64(raw); ok && int64(len(list)) > n {
				return false
			}
		}
		if items, ok := schema["items"].(map[string]any); ok {
			for _, child := range list {
				if !schemaAllowsValue(items, child, depth+1) {
					return false
				}
			}
		}
	}
	return true
}

func valueMatchesSchemaType(v any, typ string) bool {
	switch strings.TrimSpace(typ) {
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "integer":
		_, ok := asInt64(v)
		return ok
	case "number":
		_, ok := asFloat64(v)
		return ok
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "array":
		_, ok := asAnySlice(v)
		return ok
	default:
		return false
	}
}

func knownSchemaType(typ string) bool {
	switch strings.TrimSpace(typ) {
	case "object", "string", "integer", "number", "boolean", "array":
		return true
	default:
		return false
	}
}

func stringAnyList(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, s)
			}
		}
		return out
	case []string:
		out := make([]string, 0, len(t))
		for _, s := range t {
			if strings.TrimSpace(s) != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func asAnySlice(v any) ([]any, bool) {
	switch t := v.(type) {
	case []any:
		return t, true
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out, true
	default:
		return nil, false
	}
}

func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int64:
		return n, true
	case uint64:
		if n > uint64(^uint64(0)>>1) {
			return 0, false
		}
		return int64(n), true
	case float64:
		if n == float64(int64(n)) {
			return int64(n), true
		}
		return 0, false
	default:
		return 0, false
	}
}

func asFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint64:
		return float64(n), true
	case float64:
		return n, true
	default:
		return 0, false
	}
}

func valuesEqual(a, b any) bool {
	ab, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bb, err := json.Marshal(b)
	if err != nil {
		return false
	}
	return string(ab) == string(bb)
}
