package webhook

import (
	"encoding/json"
	"mime"
	"regexp"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

var identRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

func validateContentType(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ErrUnsupportedType
	}
	mediatype, _, err := mime.ParseMediaType(raw)
	if err != nil {
		return ErrUnsupportedType
	}
	if !strings.EqualFold(mediatype, "application/json") {
		return ErrUnsupportedType
	}
	return nil
}

// ContentTypeMatches reports whether the request media type is the accepted JSON type.
func ContentTypeMatches(got, want string) bool {
	if strings.TrimSpace(got) == "" {
		return false
	}
	gotType, _, err := mime.ParseMediaType(got)
	if err != nil {
		return false
	}
	wantType, _, err := mime.ParseMediaType(firstNonEmpty(want, "application/json"))
	if err != nil {
		return false
	}
	return strings.EqualFold(gotType, wantType)
}

func sanitizeMapping(in map[string]string) map[string]string {
	out := map[string]string{}
	if in == nil {
		return out
	}
	for dest, src := range in {
		dest = strings.TrimSpace(dest)
		src = strings.TrimSpace(src)
		if dest == "" || src == "" {
			continue
		}
		out[dest] = src
	}
	return out
}

func validateMapping(in map[string]string) error {
	if len(in) > workflow.MaxObjectFields {
		return ErrInvalid
	}
	for dest, src := range in {
		if !identRE.MatchString(dest) {
			return ErrInvalid
		}
		if err := validatePath(src); err != nil {
			return err
		}
	}
	return nil
}

func validatePath(path string) error {
	path = strings.TrimSpace(path)
	if path == "" || strings.Contains(path, "..") || strings.HasPrefix(path, ".") || strings.HasSuffix(path, ".") {
		return ErrInvalid
	}
	for _, part := range strings.Split(path, ".") {
		if !identRE.MatchString(part) {
			return ErrInvalid
		}
	}
	return nil
}

// MapFields copies allowlisted dotted paths from a parsed object into typed input.
// An empty mapping copies the root object. Values are never interpreted as YAML,
// shell, template, or code.
func MapFields(payload map[string]any, mapping map[string]string) (map[string]any, error) {
	if payload == nil {
		payload = map[string]any{}
	}
	if len(mapping) == 0 {
		return cloneObject(payload), nil
	}
	out := map[string]any{}
	for dest, src := range mapping {
		if err := validatePath(src); err != nil {
			return nil, err
		}
		if !identRE.MatchString(dest) {
			return nil, ErrInvalid
		}
		if v, ok := lookupPath(payload, src); ok {
			out[dest] = v
		}
	}
	return out, nil
}

func lookupPath(root map[string]any, path string) (any, bool) {
	cur := any(root)
	for _, part := range strings.Split(path, ".") {
		obj, ok := cur.(map[string]any)
		if !ok || obj == nil {
			return nil, false
		}
		next, ok := obj[part]
		if !ok {
			return nil, false
		}
		cur = next
	}
	return cur, true
}

func cloneObject(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

// ParseJSONObject decodes a JSON object after signature verification.
func ParseJSONObject(raw []byte) (map[string]any, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, ErrInvalid
	}
	obj, ok := v.(map[string]any)
	if !ok || obj == nil {
		return nil, ErrInvalid
	}
	if dec.More() {
		return nil, ErrInvalid
	}
	return obj, nil
}
