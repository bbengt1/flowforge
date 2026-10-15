package workflow

import "fmt"

// FieldError is a single actionable validation failure. Messages are safe to
// return to clients: they never include secret material or raw request bodies.
type FieldError struct {
	Path string `json:"path"`
	// NodeID names the node for publish-time expression errors (#650
	// E3.2), which carry no line or column.
	NodeID  string `json:"nodeId,omitempty"`
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Documented validation error codes.
const (
	CodeMalformedYAML         = "malformed-yaml"
	CodeUnsupportedTag        = "unsupported-tag"
	CodeAliasForbidden        = "alias-forbidden"
	CodeDuplicateKey          = "duplicate-key"
	CodeMultipleDocuments     = "multiple-documents"
	CodeDocumentTooLarge      = "document-too-large"
	CodeDepthLimit            = "depth-limit"
	CodeNodeLimit             = "node-limit"
	CodeScalarTooLarge        = "scalar-too-large"
	CodeTemplateForbidden     = "template-forbidden"
	CodeUnknownField          = "unknown-field"
	CodeInvalidAPIVersion     = "invalid-api-version"
	CodeInvalidKind           = "invalid-kind"
	CodeInvalidName           = "invalid-name"
	CodeInvalidID             = "invalid-id"
	CodeMissingField          = "missing-field"
	CodeInvalidType           = "invalid-type"
	CodeDuplicateID           = "duplicate-id"
	CodeUnknownNodeType       = "unknown-node-type"
	CodeUnsupportedNode       = "unsupported-node"
	CodeUnknownTriggerType    = "unknown-trigger-type"
	CodeUnsupportedTrigger    = "unsupported-trigger"
	CodeInvalidPort           = "invalid-port"
	CodeIncompatiblePorts     = "incompatible-ports"
	CodeUnresolvedReference   = "unresolved-reference"
	CodeDisconnectedNode      = "disconnected-node"
	CodeCycle                 = "cycle"
	CodeUnsafeReference       = "unsafe-reference"
	CodeInvalidUUID           = "invalid-uuid"
	CodeInvalidWith           = "invalid-with"
	CodeSecretForbidden       = "secret-forbidden"
	CodeRequiredInput         = "required-input"
	CodeUpstreamSkipped       = "upstream-skipped"
	CodeDuplicateEdge         = "duplicate-edge"
	CodeClassificationDenied  = "classification-denied"
	CodeOutputTooLarge        = "output-too-large"
	CodeAggregationLimit      = "aggregation-limit"
	CodeInvalidSchema         = "invalid-schema"
	CodeDurationLimit         = "duration-limit"
	CodeExpressionForbidden   = "expression-forbidden"
	CodeRetryDenied           = "retry-denied"
	CodeInvalidEntrypoint     = "invalid-entrypoint"
	CodeInvalidSource         = "invalid-source"
	CodeInvalidRuntimeProfile = "invalid-runtime-profile"
	CodeInvalidVerification   = "invalid-verification"
	// #649 S1 onError publish validation.
	CodeInvalidOnError    = "invalid-on-error"
	CodeOnErrorNotAllowed = "on-error-not-allowed"
	// CodeErrorTriggerNotAlone: the error trigger must be the only trigger (#649 S3).
	CodeErrorTriggerNotAlone    = "error-trigger-not-alone"
	CodeErrorEdgeMissing        = "error-edge-missing"
	CodeErrorEdgeWithoutHandler = "error-edge-without-error-output"
	// CodeOnErrorContinueNoPrimary refuses onError: continue on a node
	// type without a primaryOutput (branching or multi-output).
	CodeOnErrorContinueNoPrimary = "on-error-continue-without-primary-output"
	// #650 E3.2 FFX publish-time codes (see internal/expr).
	CodeExpressionParse          = "expression-parse"
	CodeExpressionType           = "expression-type"
	CodeExpressionRefUnknown     = "expression-ref-unknown"
	CodeExpressionRefNotAncestor = "expression-ref-not-ancestor"
	CodeExpressionSecretUse      = "expression-secret-use"
	CodeExpressionTooComplex     = "expression-too-complex"
)

func fieldError(path string, line, column int, code, message string) FieldError {
	return FieldError{Path: path, Line: line, Column: column, Code: code, Message: message}
}

func (e FieldError) Error() string {
	if e.Path == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Path, e.Message)
}

// ErrorList is a set of field errors. Empty means the definition is valid.
type ErrorList []FieldError

func (e ErrorList) Error() string {
	if len(e) == 0 {
		return ""
	}
	if len(e) == 1 {
		return e[0].Error()
	}
	return fmt.Sprintf("%s (and %d more)", e[0].Error(), len(e)-1)
}
