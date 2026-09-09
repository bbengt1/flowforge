package ssh

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	maxSchemaProperties = 16
	maxParamBytes       = 256
	maxPatternLen       = 128
	maxEnumItems        = 32
)

var (
	paramNameRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,31}$`)
	placeholder = regexp.MustCompile(`\{([A-Za-z][A-Za-z0-9_]{0,31})\}`)
)

var interpolationTokens = []string{"$(", "`", "${", "{{"}

// ParameterTypeInfo documents one allowed schema type for Chloe.
type ParameterTypeInfo struct {
	Type        string   `json:"type"`
	Constraints []string `json:"constraints"`
	Description string   `json:"description"`
}

// AllowedParameterTypes is the closed schema vocabulary.
func AllowedParameterTypes() []ParameterTypeInfo {
	return []ParameterTypeInfo{
		{Type: "string", Constraints: []string{"enum", "minLength", "maxLength", "pattern", "sensitive"}, Description: "Quoted by the reviewed renderer. Pattern is a full-string regular expression."},
		{Type: "integer", Constraints: []string{"enum", "minimum", "maximum"}, Description: "Decimal digits only. Rendered unquoted after schema checks."},
		{Type: "boolean", Constraints: []string{}, Description: "JSON true/false. Rendered as true or false."},
	}
}

// ParameterSchema is the reviewed, restricted object schema for a profile.
type ParameterSchema struct {
	Type                 string                       `json:"type"`
	AdditionalProperties bool                         `json:"additionalProperties"`
	Required             []string                     `json:"required,omitempty"`
	Properties           map[string]ParameterProperty `json:"properties"`
}

// ParameterProperty is one typed parameter constraint.
type ParameterProperty struct {
	Type      string `json:"type"`
	Enum      []any  `json:"enum,omitempty"`
	MinLength *int   `json:"minLength,omitempty"`
	MaxLength *int   `json:"maxLength,omitempty"`
	Pattern   string `json:"pattern,omitempty"`
	Minimum   *int   `json:"minimum,omitempty"`
	Maximum   *int   `json:"maximum,omitempty"`
	Sensitive bool   `json:"sensitive,omitempty"`
	patternRE *regexp.Regexp
}

// NormalizeParameterSchema validates and canonicalizes a restricted object schema.
func NormalizeParameterSchema(raw map[string]any) (map[string]any, *ParameterSchema, error) {
	if raw == nil {
		return nil, nil, wrapInvalid("parameterSchema is required")
	}
	if err := rejectUnknown(raw, "type", "additionalProperties", "required", "properties"); err != nil {
		return nil, nil, err
	}
	typ, _ := raw["type"].(string)
	if strings.TrimSpace(typ) != "object" {
		return nil, nil, wrapInvalid("parameterSchema.type must be object")
	}
	if rawAdd, ok := raw["additionalProperties"]; ok {
		b, ok := rawAdd.(bool)
		if !ok {
			return nil, nil, wrapInvalid("parameterSchema.additionalProperties must be a boolean")
		}
		if b {
			return nil, nil, wrapInvalid("parameterSchema.additionalProperties must be false")
		}
	}
	propsRaw, err := objectField(raw, "properties")
	if err != nil {
		return nil, nil, err
	}
	if propsRaw == nil {
		propsRaw = map[string]any{}
	}
	if len(propsRaw) > maxSchemaProperties {
		return nil, nil, wrapInvalid("parameterSchema.properties exceeds %d items", maxSchemaProperties)
	}
	schema := &ParameterSchema{
		Type:                 "object",
		AdditionalProperties: false,
		Properties:           map[string]ParameterProperty{},
	}
	canonProps := map[string]any{}
	names := make([]string, 0, len(propsRaw))
	for name := range propsRaw {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !paramNameRE.MatchString(name) {
			return nil, nil, wrapInvalid("parameterSchema.properties.%s is not a valid parameter name", name)
		}
		propRaw, ok := propsRaw[name].(map[string]any)
		if !ok {
			return nil, nil, wrapInvalid("parameterSchema.properties.%s must be an object", name)
		}
		prop, canon, err := normalizeProperty(name, propRaw)
		if err != nil {
			return nil, nil, err
		}
		schema.Properties[name] = prop
		canonProps[name] = canon
	}
	required, err := stringList(raw, "required", maxSchemaProperties, 32)
	if err != nil {
		return nil, nil, err
	}
	if required != nil {
		for _, name := range required {
			if _, ok := schema.Properties[name]; !ok {
				return nil, nil, wrapInvalid("parameterSchema.required references unknown property %s", name)
			}
		}
		schema.Required = required
	}
	out := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties":           canonProps,
	}
	if len(schema.Required) > 0 {
		req := make([]any, len(schema.Required))
		for i, n := range schema.Required {
			req[i] = n
		}
		out["required"] = req
	}
	return out, schema, nil
}

func normalizeProperty(name string, raw map[string]any) (ParameterProperty, map[string]any, error) {
	if err := rejectUnknown(raw, "type", "enum", "minLength", "maxLength", "pattern", "minimum", "maximum", "sensitive", "description"); err != nil {
		return ParameterProperty{}, nil, err
	}
	typ, _ := raw["type"].(string)
	typ = strings.TrimSpace(typ)
	switch typ {
	case "string", "integer", "boolean":
	default:
		return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.type must be string, integer, or boolean", name)
	}
	prop := ParameterProperty{Type: typ}
	canon := map[string]any{"type": typ}
	if desc, ok := raw["description"].(string); ok {
		desc = strings.TrimSpace(desc)
		if len(desc) > 200 {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.description is too long", name)
		}
		if desc != "" {
			canon["description"] = desc
		}
	}
	if rawSens, ok := raw["sensitive"]; ok {
		b, ok := rawSens.(bool)
		if !ok {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.sensitive must be a boolean", name)
		}
		prop.Sensitive = b
		if b {
			canon["sensitive"] = true
		}
	}
	if rawEnum, ok := raw["enum"]; ok {
		arr, ok := rawEnum.([]any)
		if !ok || len(arr) == 0 || len(arr) > maxEnumItems {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.enum is invalid", name)
		}
		enum := make([]any, 0, len(arr))
		for _, item := range arr {
			if err := valueMatchesType(typ, item); err != nil {
				return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.enum contains a value that is not %s", name, typ)
			}
			enum = append(enum, item)
		}
		prop.Enum = enum
		canon["enum"] = enum
	}
	switch typ {
	case "string":
		if v, ok, err := optionalInt(raw, "minLength", 0, maxParamBytes); err != nil {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.minLength is invalid", name)
		} else if ok {
			prop.MinLength = &v
			canon["minLength"] = v
		}
		if v, ok, err := optionalInt(raw, "maxLength", 1, maxParamBytes); err != nil {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.maxLength is invalid", name)
		} else if ok {
			prop.MaxLength = &v
			canon["maxLength"] = v
		}
		if prop.MinLength != nil && prop.MaxLength != nil && *prop.MinLength > *prop.MaxLength {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.minLength cannot exceed maxLength", name)
		}
		if v, ok, err := optionalString(raw, "pattern", 1, maxPatternLen); err != nil {
			return ParameterProperty{}, nil, err
		} else if ok {
			re, compileErr := regexp.Compile("^(?:" + v + ")$")
			if compileErr != nil {
				return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.pattern is not a valid regular expression", name)
			}
			prop.Pattern = v
			prop.patternRE = re
			canon["pattern"] = v
		}
		if _, ok := raw["minimum"]; ok {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.minimum is only valid for integer", name)
		}
		if _, ok := raw["maximum"]; ok {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.maximum is only valid for integer", name)
		}
	case "integer":
		if v, ok, err := optionalInt(raw, "minimum", -1_000_000, 1_000_000); err != nil {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.minimum is invalid", name)
		} else if ok {
			prop.Minimum = &v
			canon["minimum"] = v
		}
		if v, ok, err := optionalInt(raw, "maximum", -1_000_000, 1_000_000); err != nil {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.maximum is invalid", name)
		} else if ok {
			prop.Maximum = &v
			canon["maximum"] = v
		}
		if prop.Minimum != nil && prop.Maximum != nil && *prop.Minimum > *prop.Maximum {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.minimum cannot exceed maximum", name)
		}
		if _, ok := raw["minLength"]; ok || raw["maxLength"] != nil || raw["pattern"] != nil {
			return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s string constraints are not valid for integer", name)
		}
	case "boolean":
		for _, key := range []string{"enum", "minLength", "maxLength", "pattern", "minimum", "maximum"} {
			if _, ok := raw[key]; ok && key != "enum" {
				return ParameterProperty{}, nil, wrapInvalid("parameterSchema.properties.%s.%s is not valid for boolean", name, key)
			}
		}
	}
	return prop, canon, nil
}

// NormalizeTemplate rejects interpolation and unknown placeholders.
func NormalizeTemplate(tmpl string, schema *ParameterSchema) (string, error) {
	tmpl = strings.TrimSpace(tmpl)
	if tmpl == "" {
		return "", wrapInvalid("template is required")
	}
	if len(tmpl) > 8192 {
		return "", wrapInvalid("template length is invalid")
	}
	for _, tok := range interpolationTokens {
		if strings.Contains(tmpl, tok) {
			return "", wrapInvalid("template cannot include shell interpolation or template syntax")
		}
	}
	if strings.Contains(tmpl, "$") {
		return "", wrapInvalid("template cannot include shell interpolation or template syntax")
	}
	placeholders := PlaceholderNames(tmpl)
	for _, name := range placeholders {
		if schema == nil || schema.Properties == nil {
			return "", wrapInvalid("template placeholder {%s} is not in parameterSchema.properties", name)
		}
		if _, ok := schema.Properties[name]; !ok {
			return "", wrapInvalid("template placeholder {%s} is not in parameterSchema.properties", name)
		}
	}
	if leftover := leftoverBraces(tmpl); leftover {
		return "", wrapInvalid("template placeholders must be {name} identifiers")
	}
	return tmpl, nil
}

// PlaceholderNames returns unique {name} tokens in template order.
func PlaceholderNames(tmpl string) []string {
	matches := placeholder.FindAllStringSubmatch(tmpl, -1)
	seen := map[string]struct{}{}
	var out []string
	for _, m := range matches {
		name := m[1]
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

func leftoverBraces(tmpl string) bool {
	stripped := placeholder.ReplaceAllString(tmpl, "")
	return strings.Contains(stripped, "{") || strings.Contains(stripped, "}")
}

// ValidateParameters checks values against the reviewed schema. Extra keys fail.
func ValidateParameters(schema *ParameterSchema, values map[string]any) error {
	if schema == nil {
		return wrapInvalid("parameterSchema is required")
	}
	if values == nil {
		values = map[string]any{}
	}
	for name := range values {
		if _, ok := schema.Properties[name]; !ok {
			return wrapInvalid("parameter %s is not in the profile schema", name)
		}
	}
	for _, name := range schema.Required {
		if _, ok := values[name]; !ok {
			return wrapInvalid("parameter %s is required", name)
		}
	}
	for name, raw := range values {
		prop := schema.Properties[name]
		if err := checkProperty(name, prop, raw); err != nil {
			return err
		}
	}
	return nil
}

func checkProperty(name string, prop ParameterProperty, raw any) error {
	if err := valueMatchesType(prop.Type, raw); err != nil {
		return wrapInvalid("parameter %s must be %s", name, prop.Type)
	}
	if len(prop.Enum) > 0 && !enumContains(prop.Enum, raw) {
		return wrapInvalid("parameter %s is not an allowed enum value", name)
	}
	switch prop.Type {
	case "string":
		s, _ := raw.(string)
		if strings.ContainsRune(s, 0) {
			return wrapInvalid("parameter %s contains a NUL byte", name)
		}
		if len(s) > maxParamBytes {
			return wrapInvalid("parameter %s exceeds %d bytes", name, maxParamBytes)
		}
		if prop.MinLength != nil && len(s) < *prop.MinLength {
			return wrapInvalid("parameter %s is shorter than minLength", name)
		}
		if prop.MaxLength != nil && len(s) > *prop.MaxLength {
			return wrapInvalid("parameter %s exceeds maxLength", name)
		}
		if prop.patternRE != nil && !prop.patternRE.MatchString(s) {
			return wrapInvalid("parameter %s does not match pattern", name)
		}
	case "integer":
		n, err := asInt(raw)
		if err != nil {
			return wrapInvalid("parameter %s must be an integer", name)
		}
		if prop.Minimum != nil && n < *prop.Minimum {
			return wrapInvalid("parameter %s is below minimum", name)
		}
		if prop.Maximum != nil && n > *prop.Maximum {
			return wrapInvalid("parameter %s exceeds maximum", name)
		}
	}
	return nil
}

func valueMatchesType(typ string, raw any) error {
	switch typ {
	case "string":
		if _, ok := raw.(string); !ok {
			return fmt.Errorf("not a string")
		}
	case "boolean":
		if _, ok := raw.(bool); !ok {
			return fmt.Errorf("not a boolean")
		}
	case "integer":
		if _, err := asInt(raw); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown type")
	}
	return nil
}

func enumContains(enum []any, raw any) bool {
	for _, item := range enum {
		if equalJSON(item, raw) {
			return true
		}
	}
	return false
}

func equalJSON(a, b any) bool {
	if as, ok := a.(string); ok {
		bs, ok := b.(string)
		return ok && as == bs
	}
	if ab, ok := a.(bool); ok {
		bb, ok := b.(bool)
		return ok && ab == bb
	}
	ai, errA := asInt(a)
	bi, errB := asInt(b)
	return errA == nil && errB == nil && ai == bi
}

func asInt(raw any) (int, error) {
	switch v := raw.(type) {
	case int:
		return v, nil
	case int64:
		return int(v), nil
	case float64:
		if v != float64(int(v)) {
			return 0, ErrInvalid
		}
		return int(v), nil
	case string:
		return strconv.Atoi(v)
	default:
		return 0, ErrInvalid
	}
}

func optionalInt(spec map[string]any, key string, min, max int) (int, bool, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return 0, false, nil
	}
	n, err := asInt(raw)
	if err != nil || n < min || n > max {
		return 0, false, ErrInvalid
	}
	return n, true, nil
}

func optionalString(spec map[string]any, key string, min, max int) (string, bool, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return "", false, nil
	}
	s, ok := raw.(string)
	if !ok {
		return "", false, wrapInvalid("%s must be a string", key)
	}
	s = strings.TrimSpace(s)
	if len(s) < min || len(s) > max {
		return "", false, wrapInvalid("%s length is invalid", key)
	}
	return s, true, nil
}

func objectField(spec map[string]any, key string) (map[string]any, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return nil, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, wrapInvalid("%s must be an object", key)
	}
	return obj, nil
}

func stringList(spec map[string]any, key string, maxItems, maxLen int) ([]string, error) {
	raw, ok := spec[key]
	if !ok || raw == nil {
		return nil, nil
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, wrapInvalid("%s must be an array of strings", key)
	}
	if len(arr) == 0 {
		return []string{}, nil
	}
	if len(arr) > maxItems {
		return nil, wrapInvalid("%s exceeds %d items", key, maxItems)
	}
	out := make([]string, 0, len(arr))
	seen := map[string]struct{}{}
	for _, item := range arr {
		s, ok := item.(string)
		if !ok {
			return nil, wrapInvalid("%s must be an array of strings", key)
		}
		s = strings.TrimSpace(s)
		if s == "" || len(s) > maxLen {
			return nil, wrapInvalid("%s contains an invalid value", key)
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out, nil
}

func rejectUnknown(spec map[string]any, allowed ...string) error {
	ok := map[string]struct{}{}
	for _, a := range allowed {
		ok[a] = struct{}{}
	}
	for key := range spec {
		if _, known := ok[key]; !known {
			return wrapInvalid("unknown field %s", key)
		}
	}
	return nil
}
