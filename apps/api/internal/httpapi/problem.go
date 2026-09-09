package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
)

const problemTypePrefix = "urn:flowforge:problem:"

// Documented problem codes. New API handlers should reuse these rather than
// inventing ad-hoc strings.
const (
	CodeInvalidRequest        = "invalid-request"
	CodeUnauthenticated       = "unauthenticated"
	CodeForbidden             = "forbidden"
	CodeNotFound              = "not-found"
	CodeConflict              = "conflict"
	CodeMethodNotAllowed      = "method-not-allowed"
	CodeRequestTooLarge       = "request-too-large"
	CodeInternalError         = "internal-error"
	CodeDependencyUnavailable = "dependency-unavailable"
	CodeInvalidWorkflow       = "invalid-workflow"
	CodeRetryDenied           = "retry-denied"
	CodeArtifactMutable       = "artifact-mutable"
	CodeArtifactUnscanned     = "artifact-unscanned"
	CodeArtifactUnsigned      = "artifact-unsigned"
	CodeArtifactScanFailed    = "artifact-scan-failed"
	CodeArtifactRevoked       = "artifact-revoked"
	CodeIsolationDenied       = "isolation-denied"
	CodeMetadataDenied        = "metadata-denied"
	CodeEgressDenied          = "egress-denied"
	CodePackageInstallDenied  = "package-install-denied"
	CodeImageDenied           = "image-denied"
	CodeResourceLimit         = "resource-limit"
	CodeIndeterminate         = "indeterminate"
)

// FieldError is a YAML-path validation failure returned on invalid-workflow.
type FieldError struct {
	Path    string `json:"path"`
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Problem is an RFC 9457 problem details document with FlowForge extensions.
type Problem struct {
	Type      string       `json:"type"`
	Title     string       `json:"title"`
	Status    int          `json:"status"`
	Detail    string       `json:"detail"`
	Instance  string       `json:"instance"`
	Code      string       `json:"code"`
	RequestID string       `json:"request_id"`
	Errors    []FieldError `json:"errors,omitempty"`
}

// WriteProblem writes an application/problem+json response. Detail must not
// include secret material or raw request bodies.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail string) {
	writeProblem(w, r, status, code, title, detail, nil)
}

// WriteProblemErrors writes a problem document with a field-level errors array.
func WriteProblemErrors(w http.ResponseWriter, r *http.Request, status int, code, title, detail string, errors []FieldError) {
	writeProblem(w, r, status, code, title, detail, errors)
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail string, errors []FieldError) {
	p := Problem{
		Type:      problemTypePrefix + code,
		Title:     title,
		Status:    status,
		Detail:    detail,
		Instance:  r.URL.Path,
		Code:      code,
		RequestID: RequestIDFromContext(r.Context()),
		Errors:    errors,
	}
	body, err := json.Marshal(p)
	if err != nil {
		http.Error(w, "failed to encode problem details", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// WriteUnauthenticated writes the documented 401 problem for missing or invalid credentials.
func WriteUnauthenticated(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, http.StatusUnauthorized, CodeUnauthenticated, "Unauthenticated", "Authentication is required.")
}

// WriteForbidden writes the documented 403 problem for an authenticated caller
// that is not authorized for the requested action.
func WriteForbidden(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "You are not authorized to perform this action.")
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// DecodeJSON reads a single JSON object from the request body into dst.
// On failure it writes a documented problem+json response and returns false.
// Error details never echo the request body (bodies may contain secrets).
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json.")
		return false
	}
	mediaType, _, err := mime.ParseMediaType(ct)
	if err != nil || mediaType != "application/json" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json.")
		return false
	}

	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		var maxBytes *http.MaxBytesError
		switch {
		case errors.As(err, &maxBytes):
			WriteProblem(w, r, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "Request Too Large", "The request body exceeds the 1048576 byte limit.")
		case errors.Is(err, io.EOF):
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Request body is required.")
		default:
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Request body is not valid JSON.")
		}
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Request body must contain a single JSON value.")
		return false
	}
	return true
}
