package workflow

import (
	"fmt"
	"strings"
)

// EvalResult is the contract evaluation outcome for a core neutral node.
// Delay never sleeps: it only reports a durable wake-up duration.
type EvalResult struct {
	Outputs        map[string]any  `json:"outputs"`
	Classification string          `json:"classification"`
	Terminal       *TerminalResult `json:"terminal,omitempty"`
	Delay          *DelayPlan      `json:"delay,omitempty"`
	Audit          map[string]any  `json:"audit"`
}

// TerminalResult ends the current execution path only.
type TerminalResult struct {
	Status  string `json:"status"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// DelayPlan is the durable wait the E5 worker must schedule.
type DelayPlan struct {
	DurationSeconds int64 `json:"durationSeconds"`
}

// Evaluate applies a core neutral node contract to with + literal inputs.
// It is deterministic and has no durable side effects.
func Evaluate(typ string, with map[string]any, inputs map[string]any) (*EvalResult, ErrorList) {
	if with == nil {
		with = map[string]any{}
	}
	if inputs == nil {
		inputs = map[string]any{}
	}
	switch typ {
	case "flow.condition":
		return evalCondition(with, inputs)
	case "flow.delay":
		return evalDelay(with, inputs)
	case "data.set":
		return evalDataSet(with)
	case "data.map":
		return evalDataMap(with, inputs)
	case "data.validate":
		return evalDataValidate(with, inputs)
	case "flow.stop":
		return evalStop(with)
	case "flow.fail":
		return evalFail(with)
	default:
		return nil, ErrorList{fieldError("type", 0, 0, CodeUnknownNodeType, fmt.Sprintf("No evaluation contract for %q.", typ))}
	}
}

func evalCondition(with, inputs map[string]any) (*EvalResult, ErrorList) {
	value, ok := inputs["value"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeRequiredInput, "flow.condition requires input value.")}
	}
	if encodedBytes(value) > MaxPortBytes {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeOutputTooLarge, fmt.Sprintf("value exceeds the %d byte limit.", MaxPortBytes))}
	}
	subject := value
	if raw, ok := with["path"].(string); ok && raw != "" {
		if !validFieldPath(raw) {
			return nil, ErrorList{fieldError("with.path", 0, 0, CodeInvalidWith, "path must be a dotted identifier path.")}
		}
		got, found := lookupPath(value, raw)
		if with["op"] == "exists" {
			return conditionRoute(value, found), nil
		}
		if !found {
			return conditionRoute(value, false), nil
		}
		subject = got
	}
	op, _ := with["op"].(string)
	matched, errs := compareDeclarative(op, subject, with["compare"])
	if len(errs) > 0 {
		return nil, errs
	}
	class, _ := classifyLiteral(redactValue(value))
	if class == ClassSecret {
		class = ClassConfidential
	}
	res := conditionRoute(value, matched)
	res.Classification = class
	res.Audit = map[string]any{
		"op":             op,
		"matched":        matched,
		"classification": class,
	}
	return res, nil
}

func conditionRoute(value any, matched bool) *EvalResult {
	out := map[string]any{"true": nil, "false": nil}
	if matched {
		out["true"] = value
	} else {
		out["false"] = value
	}
	return &EvalResult{Outputs: out}
}

func compareDeclarative(op string, subject, compare any) (bool, ErrorList) {
	switch op {
	case "exists":
		return subject != nil, nil
	case "eq":
		return valuesEqual(subject, compare), nil
	case "ne":
		return !valuesEqual(subject, compare), nil
	case "contains":
		switch s := subject.(type) {
		case string:
			c, ok := compare.(string)
			if !ok {
				return false, ErrorList{fieldError("with.compare", 0, 0, CodeInvalidType, "contains on a string requires a string compare value.")}
			}
			return strings.Contains(s, c), nil
		case []any:
			if len(s) > MaxAggregationItems {
				return false, ErrorList{fieldError("inputs.value", 0, 0, CodeAggregationLimit, fmt.Sprintf("contains cannot scan more than %d items.", MaxAggregationItems))}
			}
			for _, item := range s {
				if valuesEqual(item, compare) {
					return true, nil
				}
			}
			return false, nil
		default:
			return false, ErrorList{fieldError("inputs.value", 0, 0, CodeInvalidType, "contains applies to strings or arrays.")}
		}
	case "gt", "lt", "gte", "lte":
		left, lok := asFloat64(subject)
		right, rok := asFloat64(compare)
		if lok && rok {
			switch op {
			case "gt":
				return left > right, nil
			case "lt":
				return left < right, nil
			case "gte":
				return left >= right, nil
			case "lte":
				return left <= right, nil
			}
		}
		ls, lok := subject.(string)
		rs, rok := compare.(string)
		if lok && rok {
			switch op {
			case "gt":
				return ls > rs, nil
			case "lt":
				return ls < rs, nil
			case "gte":
				return ls >= rs, nil
			case "lte":
				return ls <= rs, nil
			}
		}
		return false, ErrorList{fieldError("with.compare", 0, 0, CodeInvalidType, "ordered comparison requires numbers or strings.")}
	default:
		return false, ErrorList{fieldError("with.op", 0, 0, CodeInvalidWith, "op must be a declarative comparison operator.")}
	}
}

func evalDelay(with, inputs map[string]any) (*EvalResult, ErrorList) {
	s, ok := with["duration"].(string)
	if !ok {
		return nil, ErrorList{fieldError("with.duration", 0, 0, CodeMissingField, "flow.delay requires with.duration.")}
	}
	secs, err := isoDurationSeconds(s)
	if err != nil {
		return nil, ErrorList{fieldError("with.duration", 0, 0, CodeInvalidWith, err.Error())}
	}
	if secs <= 0 || secs > MaxDelaySeconds {
		return nil, ErrorList{fieldError("with.duration", 0, 0, CodeDurationLimit, fmt.Sprintf("duration must be between 1 and %d seconds.", MaxDelaySeconds))}
	}
	result := any(map[string]any{})
	class := ClassPublic
	if raw, ok := inputs["input"]; ok {
		if encodedBytes(raw) > MaxPortBytes {
			return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeOutputTooLarge, fmt.Sprintf("input exceeds the %d byte limit.", MaxPortBytes))}
		}
		if m, ok := raw.(map[string]any); ok {
			result = m
		} else {
			result = map[string]any{"value": raw}
		}
		if c, errs := classifyLiteral(raw); len(errs) > 0 {
			return nil, relocateErrors(errs, "inputs.input")
		} else {
			class = c
		}
	}
	return &EvalResult{
		Outputs:        map[string]any{"result": result},
		Classification: class,
		Delay:          &DelayPlan{DurationSeconds: secs},
		Audit:          map[string]any{"durationSeconds": secs},
	}, nil
}

func evalDataSet(with map[string]any) (*EvalResult, ErrorList) {
	raw, ok := with["value"]
	if !ok {
		return nil, ErrorList{fieldError("with.value", 0, 0, CodeMissingField, "data.set requires with.value.")}
	}
	value, ok := raw.(map[string]any)
	if !ok {
		return nil, ErrorList{fieldError("with.value", 0, 0, CodeInvalidType, "value must be an object.")}
	}
	class := ClassPublic
	if rawClass, ok := with["classification"].(string); ok {
		class = rawClass
	}
	if !allowedLiteralClassification(class) {
		return nil, ErrorList{fieldError("with.classification", 0, 0, CodeClassificationDenied, "data.set classification must be public or internal.")}
	}
	if rawSchema, ok := with["schema"]; ok {
		schema, errs := asSchemaMap(rawSchema, "with.schema")
		if len(errs) > 0 {
			return nil, errs
		}
		schemaClass, schemaErrs := validateAgainstSchema(value, schema, "with.value", *defaultNeutralBounds())
		if len(schemaErrs) > 0 {
			return nil, schemaErrs
		}
		class = maxClassification(class, schemaClass)
	}
	if inferred, errs := classifyLiteral(value); len(errs) > 0 {
		return nil, relocateErrors(errs, "with.value")
	} else {
		class = maxClassification(class, inferred)
	}
	if !allowedLiteralClassification(class) {
		return nil, ErrorList{fieldError("with.value", 0, 0, CodeClassificationDenied, "data.set accepts only public or internal fields.")}
	}
	if encodedBytes(value) > MaxPortBytes {
		return nil, ErrorList{fieldError("with.value", 0, 0, CodeOutputTooLarge, fmt.Sprintf("value exceeds the %d byte limit.", MaxPortBytes))}
	}
	return &EvalResult{
		Outputs:        map[string]any{"result": value},
		Classification: class,
		Audit: map[string]any{
			"fieldCount":     len(value),
			"classification": class,
		},
	}, nil
}

func evalDataMap(with, inputs map[string]any) (*EvalResult, ErrorList) {
	rawIn, ok := inputs["input"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeRequiredInput, "data.map requires input input.")}
	}
	src, ok := rawIn.(map[string]any)
	if !ok {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeInvalidType, "data.map input must be an object.")}
	}
	if encodedBytes(src) > MaxPortBytes {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeOutputTooLarge, fmt.Sprintf("input exceeds the %d byte limit.", MaxPortBytes))}
	}
	if aggregationItems(src) > MaxAggregationItems {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeAggregationLimit, fmt.Sprintf("input exceeds the aggregation limit of %d fields.", MaxAggregationItems))}
	}
	mapping, ok := with["mapping"].(map[string]any)
	if !ok {
		return nil, ErrorList{fieldError("with.mapping", 0, 0, CodeInvalidType, "mapping must be an object.")}
	}
	out := map[string]any{}
	class := ClassPublic
	mapped := 0
	for dest, spec := range mapping {
		from, convert, specErrs := parseMappingSpec(spec, "with.mapping."+dest)
		if len(specErrs) > 0 {
			return nil, specErrs
		}
		got, found := lookupPath(src, from)
		if !found {
			return nil, ErrorList{fieldError("with.mapping."+dest, 0, 0, CodeUnresolvedReference, fmt.Sprintf("Source path %q is not present on input.", from))}
		}
		if convert != "" {
			converted, ok := convertScalar(got, convert)
			if !ok {
				return nil, ErrorList{fieldError("with.mapping."+dest, 0, 0, CodeInvalidType, fmt.Sprintf("Cannot convert %q to %s.", from, convert))}
			}
			got = converted
		}
		if list, ok := got.([]any); ok && len(list) > MaxAggregationItems {
			return nil, ErrorList{fieldError("with.mapping."+dest, 0, 0, CodeAggregationLimit, fmt.Sprintf("Mapped collection exceeds %d items.", MaxAggregationItems))}
		}
		if !setPath(out, dest, got) {
			return nil, ErrorList{fieldError("with.mapping."+dest, 0, 0, CodeInvalidWith, "Destination path could not be written.")}
		}
		mapped++
		if c, errs := classifyLiteral(got); len(errs) > 0 {
			return nil, relocateErrors(errs, "with.mapping."+dest)
		} else {
			class = maxClassification(class, c)
		}
	}
	if encodedBytes(out) > MaxPortBytes {
		return nil, ErrorList{fieldError("result", 0, 0, CodeOutputTooLarge, fmt.Sprintf("mapped result exceeds the %d byte limit.", MaxPortBytes))}
	}
	return &EvalResult{
		Outputs:        map[string]any{"result": out},
		Classification: class,
		Audit: map[string]any{
			"mappedFields":   mapped,
			"classification": class,
		},
	}, nil
}

func evalDataValidate(with, inputs map[string]any) (*EvalResult, ErrorList) {
	value, ok := inputs["value"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeRequiredInput, "data.validate requires input value.")}
	}
	schema, errs := asSchemaMap(with["schema"], "with.schema")
	if len(errs) > 0 {
		return nil, errs
	}
	class, schemaErrs := validateAgainstSchema(value, schema, "inputs.value", *defaultNeutralBounds())
	if len(schemaErrs) > 0 {
		failed := make([]string, 0, len(schemaErrs))
		for _, e := range schemaErrs {
			failed = append(failed, e.Path)
			e.Message = safeSchemaMessage(e)
			errs = append(errs, e)
		}
		return &EvalResult{
			Audit: map[string]any{"valid": false, "failedPaths": failed},
		}, errs
	}
	if encodedBytes(value) > MaxPortBytes {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeOutputTooLarge, fmt.Sprintf("value exceeds the %d byte limit.", MaxPortBytes))}
	}
	return &EvalResult{
		Outputs:        map[string]any{"result": value},
		Classification: class,
		Audit:          map[string]any{"valid": true, "failedPaths": []string{}},
	}, nil
}

func safeSchemaMessage(e FieldError) string {
	if strings.Contains(strings.ToLower(e.Message), "secret") {
		return "Field failed validation."
	}
	return e.Message
}

func evalStop(with map[string]any) (*EvalResult, ErrorList) {
	status := "success"
	if raw, ok := with["status"].(string); ok && raw != "" {
		status = raw
	}
	if !oneOf(status, stopStatuses...) {
		return nil, ErrorList{fieldError("with.status", 0, 0, CodeInvalidWith, "status must be success, failure, or canceled.")}
	}
	if errs := validateSafeMessage(with["message"], "with.message", loc{}); len(errs) > 0 {
		return nil, errs
	}
	msg, _ := with["message"].(string)
	result := map[string]any{"status": status}
	if msg != "" {
		result["message"] = msg
	}
	return &EvalResult{
		Outputs:        map[string]any{"result": result},
		Classification: ClassPublic,
		Terminal:       &TerminalResult{Status: status, Message: msg},
		Audit:          map[string]any{"status": status},
	}, nil
}

func evalFail(with map[string]any) (*EvalResult, ErrorList) {
	code, _ := with["code"].(string)
	if !validFailCode(code) {
		return nil, ErrorList{fieldError("with.code", 0, 0, CodeInvalidWith, "code must be a DNS label or dotted operator token.")}
	}
	if errs := validateSafeMessage(with["message"], "with.message", loc{}); len(errs) > 0 {
		return nil, errs
	}
	msg, _ := with["message"].(string)
	result := map[string]any{"status": "failure", "code": code}
	if msg != "" {
		result["message"] = msg
	}
	return &EvalResult{
		Outputs:        map[string]any{"result": result},
		Classification: ClassPublic,
		Terminal:       &TerminalResult{Status: "failure", Code: code, Message: msg},
		Audit:          map[string]any{"status": "failure", "code": code},
	}, nil
}
