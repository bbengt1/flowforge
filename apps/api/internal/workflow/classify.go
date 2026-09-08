package workflow

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

const redactedPlaceholder = "[redacted]"

var (
	secretValueRE = regexp.MustCompile(`(?i)(-----BEGIN |Bearer |ghp_|sk-|xox[baprs]-)`)
	stackTraceRE  = regexp.MustCompile(`(?i)(goroutine \d+|panic:|Traceback \(most recent call last\)|Exception in thread)`)
	expressionRE  = regexp.MustCompile(`\{\{|}}|\{%|%\}|\$\{|<%|[|]{2}|&&`)
	fieldPathRE   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
)

func encodedBytes(v any) int {
	if v == nil {
		return 0
	}
	b, err := json.Marshal(v)
	if err != nil {
		return MaxPortBytes + 1
	}
	return len(b)
}

func aggregationItems(v any) int {
	switch t := v.(type) {
	case map[string]any:
		return len(t)
	case []any:
		return len(t)
	default:
		return 0
	}
}

func valueDepth(v any) int {
	switch t := v.(type) {
	case map[string]any:
		max := 0
		for _, child := range t {
			if d := valueDepth(child); d > max {
				max = d
			}
		}
		return max + 1
	case []any:
		max := 0
		for _, child := range t {
			if d := valueDepth(child); d > max {
				max = d
			}
		}
		return max + 1
	default:
		return 1
	}
}

func validFieldPath(s string) bool {
	if !fieldPathRE.MatchString(s) {
		return false
	}
	return strings.Count(s, ".")+1 <= MaxFieldPathDepth
}

func looksLikeExpression(s string) bool {
	return expressionRE.MatchString(s) || templateRE.MatchString(s)
}

func looksLikeSecretValue(s string) bool {
	return secretValueRE.MatchString(s) || pemOrTokenRE.MatchString(s)
}

func looksLikeInternalError(s string) bool {
	return stackTraceRE.MatchString(s)
}

func classificationRank(c string) int {
	switch c {
	case ClassPublic:
		return 1
	case ClassInternal:
		return 2
	case ClassConfidential:
		return 3
	case ClassSecret:
		return 4
	default:
		return 1
	}
}

func maxClassification(a, b string) string {
	if classificationRank(a) >= classificationRank(b) {
		if a == "" {
			return ClassPublic
		}
		return a
	}
	return b
}

func allowedLiteralClassification(c string) bool {
	return c == "" || c == ClassPublic || c == ClassInternal
}

func classifyLiteral(v any) (string, ErrorList) {
	var errs ErrorList
	class := ClassPublic
	var walk func(any, string)
	walk = func(cur any, path string) {
		switch t := cur.(type) {
		case map[string]any:
			for k, child := range t {
				childPath := joinPath(path, k)
				if unsafeKeyRE.MatchString(k) {
					errs = append(errs, fieldError(childPath, 0, 0, CodeClassificationDenied, "Secret-classified keys are not allowed on core data nodes."))
					continue
				}
				lower := strings.ToLower(k)
				if strings.Contains(lower, "classification") {
					if s, ok := child.(string); ok && !allowedLiteralClassification(s) {
						errs = append(errs, fieldError(childPath, 0, 0, CodeClassificationDenied, "data.set/map literals may only be public or internal."))
					}
				}
				walk(child, childPath)
			}
		case []any:
			for i, child := range t {
				walk(child, indexPath(path, i))
			}
		case string:
			if looksLikeSecretValue(t) {
				errs = append(errs, fieldError(path, 0, 0, CodeSecretForbidden, "Secret material is not allowed in core node data."))
			}
		}
	}
	walk(v, "")
	if errs != nil {
		return ClassSecret, errs
	}
	return class, nil
}

func redactValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			if unsafeKeyRE.MatchString(k) {
				out[k] = redactedPlaceholder
				continue
			}
			out[k] = redactValue(child)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = redactValue(child)
		}
		return out
	case string:
		if looksLikeSecretValue(t) {
			return redactedPlaceholder
		}
		return t
	default:
		return t
	}
}

func redactForAudit(v any, classification string) any {
	if classification == ClassConfidential || classification == ClassSecret {
		return redactedPlaceholder
	}
	return redactValue(v)
}

func lookupPath(v any, path string) (any, bool) {
	if path == "" {
		return v, true
	}
	cur := v
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		next, ok := m[part]
		if !ok {
			return nil, false
		}
		cur = next
	}
	return cur, true
}

func setPath(dst map[string]any, path string, value any) bool {
	parts := strings.Split(path, ".")
	if len(parts) == 0 || parts[0] == "" {
		return false
	}
	cur := dst
	for i, part := range parts {
		if i == len(parts)-1 {
			cur[part] = value
			return true
		}
		next, ok := cur[part].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[part] = next
		}
		cur = next
	}
	return false
}

func convertScalar(v any, kind string) (any, bool) {
	switch kind {
	case "", "any":
		return v, true
	case "string":
		switch t := v.(type) {
		case string:
			return t, true
		case bool:
			if t {
				return "true", true
			}
			return "false", true
		case int, int64, uint64:
			return jsonNumberString(t), true
		case float64:
			return jsonNumberString(t), true
		default:
			return nil, false
		}
	case "integer":
		if n, ok := asInt64(v); ok {
			return n, true
		}
		if s, ok := v.(string); ok {
			n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
			if err == nil {
				return n, true
			}
		}
		return nil, false
	case "boolean":
		switch t := v.(type) {
		case bool:
			return t, true
		case string:
			switch t {
			case "true":
				return true, true
			case "false":
				return false, true
			}
		}
		return nil, false
	case "object":
		m, ok := v.(map[string]any)
		return m, ok
	default:
		return nil, false
	}
}

func jsonNumberString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
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
