package workflow

import "fmt"

// FieldError is a single actionable validation failure. Messages are safe to
// return to clients: they never include secret material or raw request bodies.
type FieldError struct {
	Path    string `json:"path"`
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Documented validation error codes.
const (
	CodeMalformedYAML        = "malformed-yaml"
	CodeUnsupportedTag       = "unsupported-tag"
	CodeAliasForbidden       = "alias-forbidden"
	CodeDuplicateKey         = "duplicate-key"
	CodeMultipleDocuments    = "multiple-documents"
	CodeDocumentTooLarge     = "document-too-large"
	CodeDepthLimit           = "depth-limit"
	CodeNodeLimit            = "node-limit"
	CodeScalarTooLarge       = "scalar-too-large"
	CodeTemplateForbidden    = "template-forbidden"
	CodeUnknownField         = "unknown-field"
	CodeInvalidAPIVersion    = "invalid-api-version"
	CodeInvalidKind          = "invalid-kind"
	CodeInvalidName          = "invalid-name"
	CodeInvalidID            = "invalid-id"
	CodeMissingField         = "missing-field"
	CodeInvalidType          = "invalid-type"
	CodeDuplicateID          = "duplicate-id"
	CodeUnknownNodeType      = "unknown-node-type"
	CodeUnsupportedNode      = "unsupported-node"
	CodeUnknownTriggerType   = "unknown-trigger-type"
	CodeUnsupportedTrigger   = "unsupported-trigger"
	CodeInvalidPort          = "invalid-port"
	CodeIncompatiblePorts    = "incompatible-ports"
	CodeUnresolvedReference  = "unresolved-reference"
	CodeDisconnectedNode     = "disconnected-node"
	CodeCycle                = "cycle"
	CodeUnsafeReference      = "unsafe-reference"
	CodeInvalidUUID          = "invalid-uuid"
	CodeInvalidWith          = "invalid-with"
	CodeSecretForbidden      = "secret-forbidden"
	CodeRequiredInput        = "required-input"
	CodeDuplicateEdge        = "duplicate-edge"
	CodeClassificationDenied = "classification-denied"
	CodeOutputTooLarge       = "output-too-large"
	CodeAggregationLimit     = "aggregation-limit"
	CodeInvalidSchema        = "invalid-schema"
	CodeDurationLimit        = "duration-limit"
	CodeExpressionForbidden  = "expression-forbidden"
	CodeRetryDenied          = "retry-denied"
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
