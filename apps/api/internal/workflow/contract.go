package workflow

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

var conditionOps = []string{"eq", "ne", "gt", "lt", "gte", "lte", "exists", "contains"}
var stopStatuses = []string{"success", "failure", "canceled"}
var convertKinds = []string{"string", "integer", "boolean", "object"}

func defaultNeutralPolicy() *NodePolicy {
	return &NodePolicy{
		Permissions:        []string{"workflow.execute"},
		RetrySafe:          true,
		SideEffects:        false,
		Idempotent:         true,
		Cancellation:       "path-local",
		Verification:       "none",
		DefaultMaxAttempts: 1,
	}
}

func defaultNeutralBounds() *NodeBounds {
	return &NodeBounds{
		MaxInputBytes:       MaxPortBytes,
		MaxOutputBytes:      MaxPortBytes,
		MaxWithBytes:        MaxWithValueBytes,
		MaxAggregationItems: MaxAggregationItems,
	}
}

func inheritPort(name string, kind PortKind, required bool, desc string) Port {
	return Port{
		Name: name, Kind: kind, Required: required,
		Classification: ClassInherit, MaxBytes: MaxPortBytes, Description: desc,
	}
}

func publicObjectPort(name, desc string) Port {
	return Port{
		Name: name, Kind: PortObject,
		Classification: ClassPublic, MaxBytes: MaxPortBytes, Description: desc,
	}
}

func flowConditionContract() NodeType {
	return NodeType{
		Type:        "flow.condition",
		Phase:       PhaseCore,
		Title:       "Condition",
		Description: "Declarative comparison only. Routes the inbound value to true or false. No expression language.",
		Inputs:      []Port{inheritPort("value", PortAny, true, "Value to compare.")},
		Outputs: []Port{
			inheritPort("true", PortAny, false, "Inbound value when the comparison is true."),
			inheritPort("false", PortAny, false, "Inbound value when the comparison is false."),
		},
		RequiredWith: []string{"op"},
		AllowedWith: []WithField{
			{Name: "op", Kind: "enum", Required: true, Enum: conditionOps, Description: "Declarative comparison operator."},
			{Name: "compare", Kind: "any", Description: "Literal compare value. Required except when op is exists."},
			{Name: "path", Kind: "string", Description: "Optional dotted identifier path into value. No expressions."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: defaultNeutralBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"op", "matched", "classification"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "mask-classified",
		},
	}
}

func flowDelayContract() NodeType {
	b := defaultNeutralBounds()
	b.MaxDurationSeconds = MaxDelaySeconds
	return NodeType{
		Type:         "flow.delay",
		Phase:        PhaseCore,
		Title:        "Delay",
		Description:  "Computes a durable wake-up time from an ISO-8601 duration. Workers must not sleep.",
		Inputs:       []Port{inheritPort("input", PortAny, false, "Optional passthrough payload.")},
		Outputs:      []Port{inheritPort("result", PortObject, false, "Passthrough of input, or an empty object.")},
		RequiredWith: []string{"duration"},
		AllowedWith: []WithField{
			{Name: "duration", Kind: "duration", Required: true, Description: "ISO-8601 duration using weeks, days, and time units. Max P7D."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: b,
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"durationSeconds"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "mask-classified",
		},
	}
}

func dataSetContract() NodeType {
	return NodeType{
		Type:         "data.set",
		Phase:        PhaseCore,
		Title:        "Set data",
		Description:  "Create a typed literal object. Schema-validated; public or internal fields only; no secrets.",
		Inputs:       []Port{},
		Outputs:      []Port{publicObjectPort("result", "The constructed object.")},
		RequiredWith: []string{"value"},
		AllowedWith: []WithField{
			{Name: "value", Kind: "object", Required: true, Description: "Literal object. Secret keys and values are rejected."},
			{Name: "schema", Kind: "schema", Description: "Optional JSON-schema subset used to type and classify fields."},
			{Name: "classification", Kind: "enum", Enum: []string{ClassPublic, ClassInternal}, Description: "Default classification when schema does not set one."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: defaultNeutralBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"fieldCount", "classification"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "mask-classified",
		},
	}
}

func dataMapContract() NodeType {
	return NodeType{
		Type:         "data.map",
		Phase:        PhaseCore,
		Title:        "Map data",
		Description:  "Declarative field mapping with optional type conversion. No general expression language.",
		Inputs:       []Port{inheritPort("input", PortObject, true, "Object to map from.")},
		Outputs:      []Port{inheritPort("result", PortObject, false, "Mapped object. Classification is preserved per field.")},
		RequiredWith: []string{"mapping"},
		AllowedWith: []WithField{
			{Name: "mapping", Kind: "mapping", Required: true, Description: "dest.path -> source.path or {from, convert}."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: defaultNeutralBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"mappedFields", "classification"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "mask-classified",
		},
	}
}

func dataValidateContract() NodeType {
	return NodeType{
		Type:         "data.validate",
		Phase:        PhaseCore,
		Title:        "Validate data",
		Description:  "Validate a value against a declared schema. Errors name fields, never secret content.",
		Inputs:       []Port{inheritPort("value", PortAny, true, "Value to validate.")},
		Outputs:      []Port{inheritPort("result", PortObject, false, "The validated value.")},
		RequiredWith: []string{"schema"},
		AllowedWith: []WithField{
			{Name: "schema", Kind: "schema", Required: true, Description: "JSON-schema subset (type, properties, required, enum, bounds)."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: defaultNeutralBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"valid", "failedPaths"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "mask-classified",
		},
	}
}

func flowStopContract() NodeType {
	return NodeType{
		Type:        "flow.stop",
		Phase:       PhaseCore,
		Title:       "Stop path",
		Description: "End the current execution path only. Cannot stop another execution.",
		Inputs:      []Port{inheritPort("input", PortAny, false, "Optional path payload. Not copied onto the result.")},
		Outputs:     []Port{publicObjectPort("result", "Safe {status, message} summary.")},
		AllowedWith: []WithField{
			{Name: "status", Kind: "enum", Enum: stopStatuses, Description: "success, failure, or canceled. Defaults to success."},
			{Name: "message", Kind: "string", Description: "Optional operator-safe message. Secrets and stack traces are rejected."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: defaultNeutralBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"status"},
			RedactInputs:  true,
			RedactOutputs: false,
			Strategy:      "drop-secrets",
		},
	}
}

func flowFailContract() NodeType {
	return NodeType{
		Type:         "flow.fail",
		Phase:        PhaseCore,
		Title:        "Fail path",
		Description:  "End the current path with a safe operator-facing failure. Code and message must not expose internals.",
		Inputs:       []Port{inheritPort("input", PortAny, false, "Optional path payload. Not copied onto the result.")},
		Outputs:      []Port{publicObjectPort("result", "Safe {status, code, message} summary.")},
		RequiredWith: []string{"code"},
		AllowedWith: []WithField{
			{Name: "code", Kind: "string", Required: true, Description: "Operator-facing failure code (DNS label or dotted token)."},
			{Name: "message", Kind: "string", Description: "Optional safe message. Secrets and stack traces are rejected."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: defaultNeutralBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"status", "code"},
			RedactInputs:  true,
			RedactOutputs: false,
			Strategy:      "drop-secrets",
		},
	}
}

func flowApprovalContract() NodeType {
	b := defaultNeutralBounds()
	b.MaxDurationSeconds = MaxDelaySeconds
	return NodeType{
		Type:        "flow.approval",
		Phase:       PhaseCore,
		Title:       "Approval gate",
		Description: "Durable mid-run wait. Parks a waiting job with no worker lease until decide, expiry, or invalidation. Typed ports: request → approved / rejected / expired.",
		Inputs:      []Port{inheritPort("request", PortObject, false, "Optional approval request payload.")},
		Outputs: []Port{
			inheritPort("approved", PortObject, false, "Emitted when an authorized approver approves."),
			inheritPort("rejected", PortObject, false, "Emitted when an authorized approver rejects."),
			inheritPort("expired", PortObject, false, "Emitted when the wait expires or the binding is invalidated."),
		},
		RequiredWith: []string{"approverRole", "expiresIn"},
		AllowedWith: []WithField{
			{Name: "approverRole", Kind: "string", Required: true, Description: "Workspace role that may decide. Requester self-approval is denied."},
			{Name: "expiresIn", Kind: "duration", Required: true, Description: "ISO-8601 wait expiry. Max P7D."},
			{Name: "policyId", Kind: "uuid", Description: "Optional published policy UUID bound into the approval snapshot."},
		},
		Policy: &NodePolicy{
			Permissions:        []string{"workflow.execute", "approval.decide"},
			RetrySafe:          true,
			SideEffects:        false,
			Idempotent:         true,
			Cancellation:       "path-local",
			Verification:       "none",
			DefaultMaxAttempts: 1,
		},
		Bounds: b,
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"approverRole", "expiresIn", "decision", "bindingFingerprint"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "mask-classified",
		},
	}
}

func coreNeutralTypes() map[string]NodeType {
	return map[string]NodeType{
		"flow.condition": flowConditionContract(),
		"flow.delay":     flowDelayContract(),
		"data.set":       dataSetContract(),
		"data.map":       dataMapContract(),
		"data.validate":  dataValidateContract(),
		"flow.stop":      flowStopContract(),
		"flow.fail":      flowFailContract(),
		"flow.approval":  flowApprovalContract(),
	}
}

// IsCoreNeutral reports whether typ is a core contract node the local
// compose worker may evaluate in-process (data.* / flow.*). Provider
// nodes stay fail-closed for that worker.
func IsCoreNeutral(typ string) bool {
	return isCoreNeutral(typ)
}

func isCoreNeutral(typ string) bool {
	_, ok := coreNeutralTypes()[typ]
	return ok
}

func allowedWithNames(nt NodeType) map[string]bool {
	out := map[string]bool{}
	for _, f := range nt.AllowedWith {
		out[f.Name] = true
	}
	return out
}

func validateCoreNeutralNode(n Node, path string) ErrorList {
	nt, ok := lookupNode(n.Type)
	if !ok {
		return nil
	}
	var errs ErrorList
	allowed := allowedWithNames(nt)
	if n.With == nil {
		n.With = map[string]any{}
	}
	bounds := defaultNeutralBounds()
	if nt.Bounds != nil {
		bounds = nt.Bounds
	}
	if encodedBytes(n.With) > bounds.MaxWithBytes {
		errs = append(errs, fieldError(path+".with", n.pos.Line, n.pos.Column, CodeOutputTooLarge, fmt.Sprintf("with exceeds the %d byte limit.", bounds.MaxWithBytes)))
	}
	for k := range n.With {
		if !allowed[k] {
			errs = append(errs, fieldError(path+".with."+k, n.pos.Line, n.pos.Column, CodeUnknownField, fmt.Sprintf("%s does not allow with.%s.", n.Type, k)))
		}
	}
	for k, v := range n.Inputs {
		if encodedBytes(v) > bounds.MaxInputBytes {
			errs = append(errs, fieldError(path+".inputs."+k, n.pos.Line, n.pos.Column, CodeOutputTooLarge, fmt.Sprintf("Input %q exceeds the %d byte limit.", k, bounds.MaxInputBytes)))
		}
	}
	withErrs := validateNeutralWith(n, nt, path)
	errs = append(errs, withErrs...)
	if len(withErrs) == 0 && canEvaluateAtValidate(n, nt) {
		_, evalErrs := Evaluate(n.Type, n.With, n.Inputs)
		for _, e := range evalErrs {
			if e.Path == "" {
				e.Path = path
			} else if !strings.HasPrefix(e.Path, path) && !strings.HasPrefix(e.Path, "spec.") {
				e.Path = path + "." + strings.TrimPrefix(e.Path, ".")
			}
			if e.Line == 0 {
				e.Line = n.pos.Line
				e.Column = n.pos.Column
			}
			errs = append(errs, e)
		}
	}
	return errs
}

func canEvaluateAtValidate(n Node, nt NodeType) bool {
	for _, p := range nt.Inputs {
		if !p.Required {
			continue
		}
		if _, ok := n.Inputs[p.Name]; !ok {
			return false
		}
	}
	return true
}

func validateNeutralWith(n Node, nt NodeType, path string) ErrorList {
	switch n.Type {
	case "flow.condition":
		return validateConditionWith(n, path)
	case "flow.delay":
		return validateDelayWith(n, path)
	case "data.set":
		return validateDataSetWith(n, path)
	case "data.map":
		return validateDataMapWith(n, path)
	case "data.validate":
		return validateDataValidateWith(n, path)
	case "flow.stop":
		return validateStopWith(n, path)
	case "flow.fail":
		return validateFailWith(n, path)
	case "flow.approval":
		return validateApprovalWith(n, path)
	default:
		_ = nt
		return nil
	}
}

func validateConditionWith(n Node, path string) ErrorList {
	var errs ErrorList
	op, _ := n.With["op"].(string)
	if op != "" && !oneOf(op, conditionOps...) {
		errs = append(errs, fieldError(path+".with.op", n.pos.Line, n.pos.Column, CodeInvalidWith, "op must be a declarative comparison operator."))
	}
	if op != "" && op != "exists" {
		if _, ok := n.With["compare"]; !ok {
			errs = append(errs, fieldError(path+".with.compare", n.pos.Line, n.pos.Column, CodeMissingField, "flow.condition requires with.compare unless op is exists."))
		}
	}
	if op == "exists" {
		if _, ok := n.With["compare"]; ok {
			errs = append(errs, fieldError(path+".with.compare", n.pos.Line, n.pos.Column, CodeUnknownField, "exists does not accept compare."))
		}
	}
	if raw, ok := n.With["path"]; ok {
		s, ok := raw.(string)
		if !ok || !validFieldPath(s) {
			errs = append(errs, fieldError(path+".with.path", n.pos.Line, n.pos.Column, CodeInvalidWith, "path must be a dotted identifier path."))
		} else if looksLikeExpression(s) {
			errs = append(errs, fieldError(path+".with.path", n.pos.Line, n.pos.Column, CodeExpressionForbidden, "Condition paths cannot contain expressions."))
		}
	}
	if raw, ok := n.With["compare"]; ok {
		if s, ok := raw.(string); ok && looksLikeExpression(s) {
			errs = append(errs, fieldError(path+".with.compare", n.pos.Line, n.pos.Column, CodeExpressionForbidden, "compare must be a literal, not an expression."))
		}
		if _, classErrs := classifyLiteral(raw); len(classErrs) > 0 {
			errs = append(errs, relocateErrors(classErrs, path+".with.compare")...)
		}
	}
	return errs
}

func validateApprovalWith(n Node, path string) ErrorList {
	var errs ErrorList
	if raw, ok := n.With["approverRole"]; ok {
		s, ok := raw.(string)
		if !ok || strings.TrimSpace(s) == "" {
			errs = append(errs, fieldError(path+".with.approverRole", n.pos.Line, n.pos.Column, CodeInvalidType, "approverRole must be a non-empty string."))
		}
	}
	raw, ok := n.With["expiresIn"]
	if !ok {
		return errs
	}
	s, ok := raw.(string)
	if !ok || !validISODuration(s) {
		return append(errs, fieldError(path+".with.expiresIn", n.pos.Line, n.pos.Column, CodeInvalidWith, "expiresIn must be an ISO-8601 duration."))
	}
	secs, err := isoDurationSeconds(s)
	if err != nil {
		return append(errs, fieldError(path+".with.expiresIn", n.pos.Line, n.pos.Column, CodeInvalidWith, err.Error()))
	}
	if secs <= 0 {
		errs = append(errs, fieldError(path+".with.expiresIn", n.pos.Line, n.pos.Column, CodeInvalidWith, "expiresIn must be greater than zero."))
	}
	if secs > MaxDelaySeconds {
		errs = append(errs, fieldError(path+".with.expiresIn", n.pos.Line, n.pos.Column, CodeDurationLimit, fmt.Sprintf("expiresIn cannot exceed P7D (%d seconds).", MaxDelaySeconds)))
	}
	return errs
}

func validateDelayWith(n Node, path string) ErrorList {
	var errs ErrorList
	raw, ok := n.With["duration"]
	if !ok {
		return errs
	}
	s, ok := raw.(string)
	if !ok || !validISODuration(s) {
		return ErrorList{fieldError(path+".with.duration", n.pos.Line, n.pos.Column, CodeInvalidWith, "duration must be an ISO-8601 duration.")}
	}
	secs, err := isoDurationSeconds(s)
	if err != nil {
		return ErrorList{fieldError(path+".with.duration", n.pos.Line, n.pos.Column, CodeInvalidWith, err.Error())}
	}
	if secs <= 0 {
		errs = append(errs, fieldError(path+".with.duration", n.pos.Line, n.pos.Column, CodeInvalidWith, "duration must be greater than zero."))
	}
	if secs > MaxDelaySeconds {
		errs = append(errs, fieldError(path+".with.duration", n.pos.Line, n.pos.Column, CodeDurationLimit, fmt.Sprintf("duration cannot exceed P7D (%d seconds).", MaxDelaySeconds)))
	}
	return errs
}

func validateDataSetWith(n Node, path string) ErrorList {
	var errs ErrorList
	raw, ok := n.With["value"]
	if !ok {
		return errs
	}
	value, ok := raw.(map[string]any)
	if !ok {
		return ErrorList{fieldError(path+".with.value", n.pos.Line, n.pos.Column, CodeInvalidType, "value must be an object.")}
	}
	if len(value) > MaxObjectFields {
		errs = append(errs, fieldError(path+".with.value", n.pos.Line, n.pos.Column, CodeAggregationLimit, fmt.Sprintf("value exceeds the limit of %d fields.", MaxObjectFields)))
	}
	if valueDepth(value) > MaxSchemaDepth {
		errs = append(errs, fieldError(path+".with.value", n.pos.Line, n.pos.Column, CodeInvalidSchema, fmt.Sprintf("value exceeds the depth limit of %d.", MaxSchemaDepth)))
	}
	if encodedBytes(value) > MaxPortBytes {
		errs = append(errs, fieldError(path+".with.value", n.pos.Line, n.pos.Column, CodeOutputTooLarge, fmt.Sprintf("value exceeds the %d byte limit.", MaxPortBytes)))
	}
	if rawClass, ok := n.With["classification"]; ok {
		s, ok := rawClass.(string)
		if !ok || !allowedLiteralClassification(s) {
			errs = append(errs, fieldError(path+".with.classification", n.pos.Line, n.pos.Column, CodeClassificationDenied, "data.set classification must be public or internal."))
		}
	}
	if rawSchema, ok := n.With["schema"]; ok {
		schema, schemaErrs := asSchemaMap(rawSchema, path+".with.schema")
		errs = append(errs, schemaErrs...)
		if schema != nil {
			errs = append(errs, validateSchemaShape(schema, path+".with.schema", 1)...)
		}
	}
	if _, classErrs := classifyLiteral(value); len(classErrs) > 0 {
		errs = append(errs, relocateErrors(classErrs, path+".with.value")...)
	}
	return errs
}

func validateDataMapWith(n Node, path string) ErrorList {
	var errs ErrorList
	raw, ok := n.With["mapping"]
	if !ok {
		return errs
	}
	mapping, ok := raw.(map[string]any)
	if !ok {
		return ErrorList{fieldError(path+".with.mapping", n.pos.Line, n.pos.Column, CodeInvalidType, "mapping must be an object of destination paths.")}
	}
	if len(mapping) == 0 {
		errs = append(errs, fieldError(path+".with.mapping", n.pos.Line, n.pos.Column, CodeInvalidWith, "mapping must declare at least one field."))
	}
	if len(mapping) > MaxMappingEntries {
		errs = append(errs, fieldError(path+".with.mapping", n.pos.Line, n.pos.Column, CodeAggregationLimit, fmt.Sprintf("mapping exceeds the limit of %d entries.", MaxMappingEntries)))
	}
	for dest, spec := range mapping {
		destPath := path + ".with.mapping." + dest
		if !validFieldPath(dest) {
			errs = append(errs, fieldError(destPath, n.pos.Line, n.pos.Column, CodeInvalidWith, "Destination path must be a dotted identifier path."))
			continue
		}
		if looksLikeExpression(dest) {
			errs = append(errs, fieldError(destPath, n.pos.Line, n.pos.Column, CodeExpressionForbidden, "Mapping paths cannot contain expressions."))
			continue
		}
		from, convert, specErrs := parseMappingSpec(spec, destPath)
		errs = append(errs, specErrs...)
		if from != "" && !validFieldPath(from) {
			errs = append(errs, fieldError(destPath, n.pos.Line, n.pos.Column, CodeInvalidWith, "Source path must be a dotted identifier path."))
		}
		if convert != "" && !oneOf(convert, convertKinds...) {
			errs = append(errs, fieldError(destPath+".convert", n.pos.Line, n.pos.Column, CodeInvalidWith, "convert must be string, integer, boolean, or object."))
		}
	}
	return errs
}

func parseMappingSpec(spec any, path string) (from, convert string, errs ErrorList) {
	switch t := spec.(type) {
	case string:
		if looksLikeExpression(t) {
			return "", "", ErrorList{fieldError(path, 0, 0, CodeExpressionForbidden, "Mapping sources cannot contain expressions.")}
		}
		return t, "", nil
	case map[string]any:
		allowed := map[string]bool{"from": true, "convert": true}
		for k := range t {
			if !allowed[k] {
				errs = append(errs, fieldError(path+"."+k, 0, 0, CodeUnknownField, fmt.Sprintf("Unknown mapping field %q.", k)))
			}
		}
		rawFrom, ok := t["from"]
		if !ok {
			errs = append(errs, fieldError(path+".from", 0, 0, CodeMissingField, "mapping object requires from."))
			return "", "", errs
		}
		from, ok = rawFrom.(string)
		if !ok || from == "" {
			errs = append(errs, fieldError(path+".from", 0, 0, CodeInvalidType, "from must be a path string."))
		} else if looksLikeExpression(from) {
			errs = append(errs, fieldError(path+".from", 0, 0, CodeExpressionForbidden, "Mapping sources cannot contain expressions."))
		}
		if raw, ok := t["convert"]; ok {
			convert, ok = raw.(string)
			if !ok {
				errs = append(errs, fieldError(path+".convert", 0, 0, CodeInvalidType, "convert must be a string."))
			}
		}
		return from, convert, errs
	default:
		return "", "", ErrorList{fieldError(path, 0, 0, CodeInvalidType, "mapping values must be a source path or {from, convert}.")}
	}
}

func validateDataValidateWith(n Node, path string) ErrorList {
	raw, ok := n.With["schema"]
	if !ok {
		return nil
	}
	schema, errs := asSchemaMap(raw, path+".with.schema")
	if schema == nil {
		return errs
	}
	return append(errs, validateSchemaShape(schema, path+".with.schema", 1)...)
}

func validateStopWith(n Node, path string) ErrorList {
	var errs ErrorList
	if raw, ok := n.With["status"]; ok {
		s, ok := raw.(string)
		if !ok || !oneOf(s, stopStatuses...) {
			errs = append(errs, fieldError(path+".with.status", n.pos.Line, n.pos.Column, CodeInvalidWith, "status must be success, failure, or canceled."))
		}
	}
	errs = append(errs, validateSafeMessage(n.With["message"], path+".with.message", n.pos)...)
	return errs
}

func validateFailWith(n Node, path string) ErrorList {
	var errs ErrorList
	if raw, ok := n.With["code"]; ok {
		s, ok := raw.(string)
		if !ok || !validFailCode(s) {
			errs = append(errs, fieldError(path+".with.code", n.pos.Line, n.pos.Column, CodeInvalidWith, "code must be a DNS label or dotted operator token."))
		}
	}
	errs = append(errs, validateSafeMessage(n.With["message"], path+".with.message", n.pos)...)
	return errs
}

func validFailCode(s string) bool {
	if validDNSLabel(s) {
		return true
	}
	parts := strings.Split(s, ".")
	if len(parts) < 2 || len(parts) > 4 {
		return false
	}
	for _, p := range parts {
		if !validDNSLabel(p) {
			return false
		}
	}
	return true
}

func validateSafeMessage(v any, path string, pos loc) ErrorList {
	if v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		return ErrorList{fieldError(path, pos.Line, pos.Column, CodeInvalidType, "message must be a string.")}
	}
	if len(s) > MaxSafeMessageBytes {
		return ErrorList{fieldError(path, pos.Line, pos.Column, CodeOutputTooLarge, fmt.Sprintf("message exceeds the %d byte limit.", MaxSafeMessageBytes))}
	}
	if looksLikeSecretValue(s) {
		return ErrorList{fieldError(path, pos.Line, pos.Column, CodeSecretForbidden, "Message must not contain secret material.")}
	}
	if looksLikeInternalError(s) {
		return ErrorList{fieldError(path, pos.Line, pos.Column, CodeUnsafeReference, "Message must not contain internal stack traces.")}
	}
	if looksLikeExpression(s) {
		return ErrorList{fieldError(path, pos.Line, pos.Column, CodeExpressionForbidden, "Message cannot contain template expressions.")}
	}
	return nil
}

func relocateErrors(errs ErrorList, prefix string) ErrorList {
	out := make(ErrorList, len(errs))
	for i, e := range errs {
		if e.Path == "" {
			e.Path = prefix
		} else {
			e.Path = joinPath(prefix, strings.TrimPrefix(e.Path, "."))
		}
		out[i] = e
	}
	return out
}

func isoDurationSeconds(s string) (int64, error) {
	if s == "" || s[0] != 'P' {
		return 0, fmt.Errorf("duration must be an ISO-8601 duration")
	}
	rest := s[1:]
	if rest == "" {
		return 0, fmt.Errorf("duration must be an ISO-8601 duration")
	}
	if hasUnit(rest, 'Y') || hasUnitBeforeT(rest, 'M') {
		return 0, fmt.Errorf("duration cannot use years or months; use weeks, days, or time units")
	}
	date, timePart, hasTime := strings.Cut(rest, "T")
	if hasTime && timePart == "" {
		return 0, fmt.Errorf("duration must be an ISO-8601 duration")
	}
	if date == "" && !hasTime {
		return 0, fmt.Errorf("duration must be an ISO-8601 duration")
	}
	if strings.ContainsRune(date, 'W') {
		if hasTime || strings.ContainsRune(date, 'D') {
			return 0, fmt.Errorf("duration must be an ISO-8601 duration")
		}
		return consumeDuration(date, []byte{'W'}, map[byte]int64{'W': 7 * 24 * 3600})
	}
	total, err := consumeDuration(date, []byte{'D'}, map[byte]int64{'D': 24 * 3600})
	if err != nil {
		return 0, err
	}
	if hasTime {
		n, err := consumeDuration(timePart, []byte{'H', 'M', 'S'}, map[byte]int64{'H': 3600, 'M': 60, 'S': 1})
		if err != nil {
			return 0, err
		}
		if total > (1<<63-1)-n {
			return 0, fmt.Errorf("duration is out of range")
		}
		total += n
	}
	return total, nil
}

func hasUnit(s string, unit byte) bool {
	return strings.IndexByte(s, unit) >= 0
}

func hasUnitBeforeT(s string, unit byte) bool {
	date, _, _ := strings.Cut(s, "T")
	return strings.IndexByte(date, unit) >= 0
}

func consumeDuration(s string, order []byte, scales map[byte]int64) (int64, error) {
	if s == "" {
		return 0, nil
	}
	var total int64
	pos := 0
	i := 0
	got := 0
	for i < len(s) {
		start := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if i == start || i >= len(s) {
			return 0, fmt.Errorf("duration must be an ISO-8601 duration")
		}
		unit := s[i]
		found := -1
		for j := pos; j < len(order); j++ {
			if order[j] == unit {
				found = j
				break
			}
		}
		if found < 0 {
			return 0, fmt.Errorf("duration must be an ISO-8601 duration")
		}
		n, err := strconv.ParseInt(s[start:i], 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("duration is out of range")
		}
		scale := scales[unit]
		if n != 0 && scale > (1<<63-1)/n {
			return 0, fmt.Errorf("duration is out of range")
		}
		add := n * scale
		if total > (1<<63-1)-add {
			return 0, fmt.Errorf("duration is out of range")
		}
		total += add
		pos = found + 1
		got++
		i++
	}
	if got == 0 {
		return 0, fmt.Errorf("duration must be an ISO-8601 duration")
	}
	return total, nil
}

// ParseISODuration converts a validated ISO-8601 duration (weeks, days, and
// time units only) into a time.Duration.
func ParseISODuration(s string) (time.Duration, error) {
	sec, err := isoDurationSeconds(s)
	if err != nil {
		return 0, err
	}
	if sec > math.MaxInt64/int64(time.Second) {
		return 0, fmt.Errorf("duration is out of range")
	}
	return time.Duration(sec) * time.Second, nil
}
