package workflow

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ExtractWebhookStartSchema returns the first webhook trigger's declared
// input schema, or nil when the workflow has no typed webhook input.
func ExtractWebhookStartSchema(yamlDoc string) map[string]any {
	if strings.TrimSpace(yamlDoc) == "" {
		return nil
	}
	res, errs := ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return nil
	}
	for _, t := range res.Document.Spec.Triggers {
		if t.Type != "webhook" {
			continue
		}
		if schema := schemaFromTriggerWith(t.With); schema != nil {
			return schema
		}
	}
	return nil
}

// ExtractWebhookContentType returns the first webhook trigger contentType.
func ExtractWebhookContentType(yamlDoc string) string {
	if strings.TrimSpace(yamlDoc) == "" {
		return ""
	}
	res, errs := ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return ""
	}
	for _, t := range res.Document.Spec.Triggers {
		if t.Type != "webhook" {
			continue
		}
		if s, ok := t.With["contentType"].(string); ok {
			return strings.TrimSpace(s)
		}
		if nested := asObjectMap(t.With["with"]); nested != nil {
			if s, ok := nested["contentType"].(string); ok {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
}

// ValidateWebhookStartInput applies the 16 KiB bound and declared schema.
func ValidateWebhookStartInput(input map[string]any, yamlDoc string) ErrorList {
	if input == nil {
		input = map[string]any{}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ErrorList{fieldError("input", 0, 0, CodeInvalidType, "Webhook input must be a JSON object.")}
	}
	if len(raw) > MaxPortBytes {
		return ErrorList{fieldError("input", 0, 0, CodeOutputTooLarge, fmt.Sprintf("Webhook input exceeds the %d byte size bound.", MaxPortBytes))}
	}
	schema := ExtractWebhookStartSchema(yamlDoc)
	if schema == nil {
		return nil
	}
	_, errs := validateAgainstSchema(input, schema, "input", *defaultNeutralBounds())
	return errs
}

func validateWebhookTrigger(t Trigger, path string) ErrorList {
	var errs ErrorList
	for k, v := range t.With {
		switch k {
		case "schema", "inputSchema":
			errs = append(errs, validateManualSchemaField(v, path+"."+k)...)
		case "contentType":
			s, ok := v.(string)
			if !ok || strings.TrimSpace(s) == "" {
				errs = append(errs, fieldError(path+".contentType", t.pos.Line, t.pos.Column, CodeInvalidType, "contentType must be a string."))
			}
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
				case "contentType":
					s, ok := nv.(string)
					if !ok || strings.TrimSpace(s) == "" {
						errs = append(errs, fieldError(path+".with.contentType", t.pos.Line, t.pos.Column, CodeInvalidType, "contentType must be a string."))
					}
				default:
					errs = append(errs, fieldError(path+".with."+nk, t.pos.Line, t.pos.Column, CodeUnknownField, "webhook with may declare only inputSchema, schema, or contentType."))
				}
			}
		default:
			errs = append(errs, fieldError(path+"."+k, t.pos.Line, t.pos.Column, CodeUnknownField, "webhook YAML may declare only inputSchema, schema, and contentType."))
		}
	}
	return errs
}
