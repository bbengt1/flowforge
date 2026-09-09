package workflow

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ExtractManualStartSchema returns the first published manual trigger's
// declared input schema, or nil when the workflow has no typed start input.
// Accepted locations match the E10.1 UI contract: schema, inputSchema,
// with.schema, and with.inputSchema.
func ExtractManualStartSchema(yamlDoc string) map[string]any {
	if strings.TrimSpace(yamlDoc) == "" {
		return nil
	}
	res, errs := ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return nil
	}
	for _, t := range res.Document.Spec.Triggers {
		if t.Type != "manual" {
			continue
		}
		if schema := schemaFromTriggerWith(t.With); schema != nil {
			return schema
		}
	}
	return nil
}

func schemaFromTriggerWith(with map[string]any) map[string]any {
	if with == nil {
		return nil
	}
	for _, key := range []string{"schema", "inputSchema"} {
		if schema := asObjectMap(with[key]); schema != nil {
			return schema
		}
	}
	if nested := asObjectMap(with["with"]); nested != nil {
		for _, key := range []string{"schema", "inputSchema"} {
			if schema := asObjectMap(nested[key]); schema != nil {
				return schema
			}
		}
	}
	return nil
}

func asObjectMap(v any) map[string]any {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return nil
	}
	return m
}

// ValidateManualStartInput applies the 16 KiB bound and, when the published
// version declares a schema, the JSON-schema subset. Secrets are not required
// here; the start path redacts before persist.
func ValidateManualStartInput(input map[string]any, yamlDoc string) ErrorList {
	if input == nil {
		input = map[string]any{}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ErrorList{fieldError("input", 0, 0, CodeInvalidType, "Start input must be a JSON object.")}
	}
	if len(raw) > MaxPortBytes {
		return ErrorList{fieldError("input", 0, 0, CodeOutputTooLarge, fmt.Sprintf("Start input exceeds the %d byte size bound.", MaxPortBytes))}
	}
	schema := ExtractManualStartSchema(yamlDoc)
	if schema == nil {
		return nil
	}
	_, errs := validateAgainstSchema(input, schema, "input", *defaultNeutralBounds())
	return errs
}

func validateManualTrigger(t Trigger, path string) ErrorList {
	var errs ErrorList
	for k, v := range t.With {
		switch k {
		case "schema", "inputSchema":
			errs = append(errs, validateManualSchemaField(v, path+"."+k)...)
		case "with":
			nested, ok := v.(map[string]any)
			if !ok && v != nil {
				errs = append(errs, fieldError(path+".with", t.pos.Line, t.pos.Column, CodeInvalidType, "with must be a mapping."))
				continue
			}
			for nk, nv := range nested {
				switch nk {
				case "schema", "inputSchema":
					errs = append(errs, validateManualSchemaField(nv, path+".with."+nk)...)
				default:
					errs = append(errs, fieldError(path+".with."+nk, t.pos.Line, t.pos.Column, CodeUnknownField, "manual with may declare only schema or inputSchema."))
				}
			}
		default:
			errs = append(errs, fieldError(path+"."+k, t.pos.Line, t.pos.Column, CodeUnknownField, "manual triggers may declare only schema or inputSchema."))
		}
	}
	return errs
}

func validateManualSchemaField(v any, path string) ErrorList {
	if v == nil {
		return nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return ErrorList{fieldError(path, 0, 0, CodeInvalidType, "schema must be a mapping.")}
	}
	return ValidateDeclaredSchema(m, path)
}
