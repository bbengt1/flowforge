package httpnotify

import (
	"encoding/json"
	"math"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/jsonnum"
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
	// minimum/maximum compare exactly; a value too large to compare
	// exactly does not match.
	for _, bound := range []struct {
		key string
		bad int
	}{{"minimum", -1}, {"maximum", 1}} {
		raw, ok := schema[bound.key]
		if !ok {
			continue
		}
		if isNonFinite(value) {
			// NaN and ±Inf cannot be compared with a bound.
			return false
		}
		if !jsonnum.IsNumber(value) || !jsonnum.IsNumber(raw) {
			continue
		}
		if c, err := jsonnum.Compare(value, raw); err != nil || c == bound.bad {
			return false
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
		if n, isNum := v.(json.Number); isNum {
			ok, _ := jsonnum.IsInteger(n)
			return ok
		}
		_, ok := asInt64(v)
		return ok
	case "number":
		return jsonnum.IsNumber(v)
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
	case json.Number:
		return jsonnum.Int64(n)
	default:
		return 0, false
	}
}

func valuesEqual(a, b any) bool {
	if jsonnum.IsNumber(a) && jsonnum.IsNumber(b) {
		c, err := jsonnum.Compare(a, b)
		return err == nil && c == 0
	}
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

// isNonFinite reports whether v is a float NaN or ±Inf. JSON cannot carry
// them, but Go-side values can.
func isNonFinite(v any) bool {
	switch f := v.(type) {
	case float64:
		return math.IsNaN(f) || math.IsInf(f, 0)
	case float32:
		return math.IsNaN(float64(f)) || math.IsInf(float64(f), 0)
	}
	return false
}
