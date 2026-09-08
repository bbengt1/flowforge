package workflow

import (
	"fmt"
	"strings"
)

var schemaTypes = map[string]bool{
	"object":  true,
	"string":  true,
	"integer": true,
	"boolean": true,
	"array":   true,
	"number":  true,
}

var schemaKeys = map[string]bool{
	"type":                 true,
	"properties":           true,
	"required":             true,
	"additionalProperties": true,
	"items":                true,
	"enum":                 true,
	"maxLength":            true,
	"maxItems":             true,
	"maxProperties":        true,
	"minimum":              true,
	"maximum":              true,
	"classification":       true,
}

// validateSchemaShape checks a declared core-node schema (data.set / data.validate).
func validateSchemaShape(schema map[string]any, path string, depth int) ErrorList {
	var errs ErrorList
	if depth > MaxSchemaDepth {
		return ErrorList{fieldError(path, 0, 0, CodeInvalidSchema, fmt.Sprintf("Schema exceeds the depth limit of %d.", MaxSchemaDepth))}
	}
	for k := range schema {
		if !schemaKeys[k] {
			errs = append(errs, fieldError(path+"."+k, 0, 0, CodeUnknownField, fmt.Sprintf("Unknown schema keyword %q.", k)))
		}
	}
	if raw, ok := schema["type"]; ok {
		s, ok := raw.(string)
		if !ok || !schemaTypes[s] {
			errs = append(errs, fieldError(path+".type", 0, 0, CodeInvalidSchema, "schema.type must be object, string, integer, boolean, array, or number."))
		}
	}
	if raw, ok := schema["classification"]; ok {
		s, ok := raw.(string)
		if !ok || !oneOf(s, ClassPublic, ClassInternal, ClassConfidential) {
			errs = append(errs, fieldError(path+".classification", 0, 0, CodeClassificationDenied, "schema.classification must be public, internal, or confidential."))
		}
		if s == ClassSecret {
			errs = append(errs, fieldError(path+".classification", 0, 0, CodeClassificationDenied, "Secret classification is not allowed on core node schemas."))
		}
	}
	if raw, ok := schema["properties"]; ok {
		props, ok := raw.(map[string]any)
		if !ok {
			errs = append(errs, fieldError(path+".properties", 0, 0, CodeInvalidType, "schema.properties must be a mapping."))
		} else if len(props) > MaxSchemaProperties {
			errs = append(errs, fieldError(path+".properties", 0, 0, CodeAggregationLimit, fmt.Sprintf("schema.properties exceeds the limit of %d.", MaxSchemaProperties)))
		} else {
			for name, child := range props {
				if !validFieldPath(name) || strings.Contains(name, ".") {
					errs = append(errs, fieldError(path+".properties."+name, 0, 0, CodeInvalidName, "Property names must be single identifiers."))
					continue
				}
				cm, ok := child.(map[string]any)
				if !ok {
					errs = append(errs, fieldError(path+".properties."+name, 0, 0, CodeInvalidType, "Each property schema must be a mapping."))
					continue
				}
				errs = append(errs, validateSchemaShape(cm, path+".properties."+name, depth+1)...)
			}
		}
	}
	if raw, ok := schema["required"]; ok {
		list, ok := raw.([]any)
		if !ok {
			errs = append(errs, fieldError(path+".required", 0, 0, CodeInvalidType, "schema.required must be a list of property names."))
		} else if len(list) > MaxSchemaProperties {
			errs = append(errs, fieldError(path+".required", 0, 0, CodeAggregationLimit, fmt.Sprintf("schema.required exceeds the limit of %d.", MaxSchemaProperties)))
		} else {
			for i, item := range list {
				if s, ok := item.(string); !ok || s == "" {
					errs = append(errs, fieldError(fmt.Sprintf("%s.required[%d]", path, i), 0, 0, CodeInvalidType, "schema.required entries must be strings."))
				}
			}
		}
	}
	if raw, ok := schema["items"]; ok {
		im, ok := raw.(map[string]any)
		if !ok {
			errs = append(errs, fieldError(path+".items", 0, 0, CodeInvalidType, "schema.items must be a mapping."))
		} else {
			errs = append(errs, validateSchemaShape(im, path+".items", depth+1)...)
		}
	}
	if raw, ok := schema["additionalProperties"]; ok {
		switch raw.(type) {
		case bool:
		default:
			errs = append(errs, fieldError(path+".additionalProperties", 0, 0, CodeInvalidType, "schema.additionalProperties must be a boolean."))
		}
	}
	if raw, ok := schema["enum"]; ok {
		list, ok := raw.([]any)
		if !ok {
			errs = append(errs, fieldError(path+".enum", 0, 0, CodeInvalidType, "schema.enum must be a list."))
		} else if len(list) > MaxAggregationItems {
			errs = append(errs, fieldError(path+".enum", 0, 0, CodeAggregationLimit, fmt.Sprintf("schema.enum exceeds the limit of %d.", MaxAggregationItems)))
		}
	}
	if raw, ok := schema["maxLength"]; ok && !isBoundedInt(raw, 0, int64(MaxPortBytes)) {
		errs = append(errs, fieldError(path+".maxLength", 0, 0, CodeInvalidWith, "schema.maxLength must be between 0 and the port byte limit."))
	}
	if raw, ok := schema["maxItems"]; ok && !isBoundedInt(raw, 0, int64(MaxAggregationItems)) {
		errs = append(errs, fieldError(path+".maxItems", 0, 0, CodeInvalidWith, fmt.Sprintf("schema.maxItems must be between 0 and %d.", MaxAggregationItems)))
	}
	if raw, ok := schema["maxProperties"]; ok && !isBoundedInt(raw, 0, int64(MaxObjectFields)) {
		errs = append(errs, fieldError(path+".maxProperties", 0, 0, CodeInvalidWith, fmt.Sprintf("schema.maxProperties must be between 0 and %d.", MaxObjectFields)))
	}
	return errs
}

func validateAgainstSchema(value any, schema map[string]any, path string, bounds NodeBounds) (string, ErrorList) {
	var errs ErrorList
	class := ClassPublic
	if raw, ok := schema["classification"].(string); ok {
		class = raw
	}
	if encodedBytes(value) > bounds.MaxInputBytes {
		return class, ErrorList{fieldError(path, 0, 0, CodeOutputTooLarge, fmt.Sprintf("Value exceeds the %d byte input limit.", bounds.MaxInputBytes))}
	}
	if n := aggregationItems(value); n > bounds.MaxAggregationItems && n > 0 {
		if _, isObj := value.(map[string]any); isObj || isSlice(value) {
			if schemaType(schema) == "object" || schemaType(schema) == "array" || schemaType(schema) == "" {
				if n > bounds.MaxAggregationItems {
					return class, ErrorList{fieldError(path, 0, 0, CodeAggregationLimit, fmt.Sprintf("Value exceeds the aggregation limit of %d items.", bounds.MaxAggregationItems))}
				}
			}
		}
	}

	if raw, ok := schema["type"].(string); ok {
		if !valueMatchesType(value, raw) {
			errs = append(errs, fieldError(path, 0, 0, CodeInvalidType, fmt.Sprintf("Value is not a %s.", raw)))
			return class, errs
		}
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
			errs = append(errs, fieldError(path, 0, 0, CodeInvalidWith, "Value is not in the declared enum."))
		}
	}
	if raw, ok := schema["maxLength"]; ok {
		if s, ok := value.(string); ok {
			if n, ok := asInt64(raw); ok && int64(len(s)) > n {
				errs = append(errs, fieldError(path, 0, 0, CodeInvalidWith, "String exceeds schema.maxLength."))
			}
		}
	}
	if raw, ok := schema["minimum"]; ok {
		if n, ok := asFloat64(value); ok {
			if min, ok := asFloat64(raw); ok && n < min {
				errs = append(errs, fieldError(path, 0, 0, CodeInvalidWith, "Value is below schema.minimum."))
			}
		}
	}
	if raw, ok := schema["maximum"]; ok {
		if n, ok := asFloat64(value); ok {
			if max, ok := asFloat64(raw); ok && n > max {
				errs = append(errs, fieldError(path, 0, 0, CodeInvalidWith, "Value is above schema.maximum."))
			}
		}
	}

	if m, ok := value.(map[string]any); ok {
		if raw, ok := schema["maxProperties"]; ok {
			if n, ok := asInt64(raw); ok && int64(len(m)) > n {
				errs = append(errs, fieldError(path, 0, 0, CodeAggregationLimit, "Object exceeds schema.maxProperties."))
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
					errs = append(errs, fieldError(joinPath(path, name), 0, 0, CodeMissingField, fmt.Sprintf("Required field %q is missing.", name)))
				}
			}
		}
		additional := true
		if raw, ok := schema["additionalProperties"].(bool); ok {
			additional = raw
		}
		for k, child := range m {
			childPath := joinPath(path, k)
			if unsafeKeyRE.MatchString(k) {
				errs = append(errs, fieldError(childPath, 0, 0, CodeClassificationDenied, "Secret-classified keys are not allowed."))
				continue
			}
			if props != nil {
				if ps, ok := props[k].(map[string]any); ok {
					childClass, childErrs := validateAgainstSchema(child, ps, childPath, bounds)
					class = maxClassification(class, childClass)
					errs = append(errs, childErrs...)
					continue
				}
			}
			if !additional {
				errs = append(errs, fieldError(childPath, 0, 0, CodeUnknownField, fmt.Sprintf("Unknown field %q is not declared in the schema.", k)))
			}
		}
	}

	if list, ok := value.([]any); ok {
		if raw, ok := schema["maxItems"]; ok {
			if n, ok := asInt64(raw); ok && int64(len(list)) > n {
				errs = append(errs, fieldError(path, 0, 0, CodeAggregationLimit, "Array exceeds schema.maxItems."))
			}
		}
		if len(list) > bounds.MaxAggregationItems {
			errs = append(errs, fieldError(path, 0, 0, CodeAggregationLimit, fmt.Sprintf("Array exceeds the aggregation limit of %d.", bounds.MaxAggregationItems)))
		}
		if items, ok := schema["items"].(map[string]any); ok {
			for i, child := range list {
				childClass, childErrs := validateAgainstSchema(child, items, indexPath(path, i), bounds)
				class = maxClassification(class, childClass)
				errs = append(errs, childErrs...)
			}
		}
	}

	if class == ClassSecret {
		errs = append(errs, fieldError(path, 0, 0, CodeClassificationDenied, "Secret-classified values cannot become port data."))
	}
	return class, errs
}

func schemaType(schema map[string]any) string {
	s, _ := schema["type"].(string)
	return s
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
		_, ok := asInt64(v)
		return ok
	case "number":
		_, ok := asFloat64(v)
		return ok
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "array":
		return isSlice(v)
	default:
		return true
	}
}

func isSlice(v any) bool {
	_, ok := v.([]any)
	return ok
}

func asSchemaMap(v any, path string) (map[string]any, ErrorList) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, ErrorList{fieldError(path, 0, 0, CodeInvalidType, "schema must be a mapping.")}
	}
	return m, nil
}
