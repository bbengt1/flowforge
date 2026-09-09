package ssh

import (
	"strconv"
	"strings"
)

// RenderResult is a quoted command line plus redacted parameter names.
type RenderResult struct {
	Command    string         `json:"command"`
	Parameters map[string]any `json:"parameters,omitempty"`
}

// QuotePOSIX wraps s in single quotes, escaping embedded quotes as '\”.
// The reviewed renderer is the only caller that substitutes into a template.
func QuotePOSIX(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Render validates values against schema and substitutes quoted tokens.
// It never concatenates raw shell fragments or evaluates interpolation.
func Render(template string, schema *ParameterSchema, values map[string]any) (RenderResult, error) {
	if schema == nil {
		return RenderResult{}, wrapInvalid("parameterSchema is required")
	}
	if values == nil {
		values = map[string]any{}
	}
	if err := ValidateParameters(schema, values); err != nil {
		return RenderResult{}, err
	}
	command := template
	safe := map[string]any{}
	for _, name := range PlaceholderNames(template) {
		raw, ok := values[name]
		if !ok {
			return RenderResult{}, wrapInvalid("parameter %s is required by the template", name)
		}
		quoted, err := renderValue(schema.Properties[name], raw)
		if err != nil {
			return RenderResult{}, err
		}
		command = strings.ReplaceAll(command, "{"+name+"}", quoted)
		if schema.Properties[name].Sensitive {
			safe[name] = "[redacted]"
		} else {
			safe[name] = raw
		}
	}
	if leftoverBraces(command) {
		return RenderResult{}, wrapInvalid("template placeholders must be {name} identifiers")
	}
	return RenderResult{Command: command, Parameters: safe}, nil
}

func renderValue(prop ParameterProperty, raw any) (string, error) {
	switch prop.Type {
	case "string":
		s, _ := raw.(string)
		return QuotePOSIX(s), nil
	case "integer":
		n, err := asInt(raw)
		if err != nil {
			return "", wrapInvalid("parameter must be an integer")
		}
		return strconv.Itoa(n), nil
	case "boolean":
		b, _ := raw.(bool)
		if b {
			return "true", nil
		}
		return "false", nil
	default:
		return "", wrapInvalid("unsupported parameter type")
	}
}

// ParseSchema rebuilds a ParameterSchema from a previously normalized spec map.
func ParseSchema(raw map[string]any) (*ParameterSchema, error) {
	_, schema, err := NormalizeParameterSchema(raw)
	return schema, err
}

// RenderFromSpec validates and renders using a stored command-profile spec.
func RenderFromSpec(spec map[string]any, values map[string]any) (RenderResult, error) {
	if spec == nil {
		return RenderResult{}, wrapInvalid("spec is required")
	}
	schemaRaw, _ := spec["parameterSchema"].(map[string]any)
	schema, err := ParseSchema(schemaRaw)
	if err != nil {
		return RenderResult{}, err
	}
	tmpl, _ := spec["template"].(string)
	return Render(tmpl, schema, values)
}
