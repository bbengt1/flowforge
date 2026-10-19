package core

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const ProblemTypePrefix = "urn:flowforge:problem:"

// Documented problem codes. New API handlers should reuse these rather than
// inventing ad-hoc strings.
const (
	CodeInvalidRequest  = "invalid-request"
	CodeUnauthenticated = "unauthenticated"
	CodeForbidden       = "forbidden"
	// CodeCSRFInvalid is the 403 for a cookie-session mutation whose
	// X-CSRF-Token is missing or does not match. Clients match this code,
	// not the detail text. A role refusal stays CodeForbidden.
	CodeCSRFInvalid           = "csrf-invalid"
	CodeNotFound              = "not-found"
	CodeConflict              = "conflict"
	CodeMethodNotAllowed      = "method-not-allowed"
	CodeRequestTooLarge       = "request-too-large"
	CodeRateLimited           = "rate-limited"
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
	// CodeMFARequired is the step-up denial for platform.administer and
	// credential.* on a local-login or OIDC session.
	CodeMFARequired = "mfa-required"
	// CodePasswordChangeRequired is the denial while the caller's local
	// login still has must_change_password set. GET /session, POST
	// /session/password, and POST /session/logout stay available.
	CodePasswordChangeRequired = "password_change_required"
	// Soft-delete conflicts. Underscores match the workflow contract.
	CodeWorkflowHasActiveExecutions = "workflow_has_active_executions"
	CodeWorkflowSlugReserved        = "workflow_slug_reserved"
	// CodeWorkflowSlugTaken is a create or import slug held by a live
	// workflow, including a derived slug that kept losing the insert race.
	// conflict is never used for a slug clash.
	CodeWorkflowSlugTaken = "workflow_slug_taken"
	// CodeSlugImmutable refuses a draft save that changes metadata.slug.
	CodeSlugImmutable = "slug_immutable"
	// CodeWorkflowDeleted is the approval-decide and retry refusal when
	// the workflow tombstone is set. The run is failed, not continued.
	CodeWorkflowDeleted = "workflow_deleted"
	// CodeExecutionNotRetryable refuses a step retry that is not eligible.
	CodeExecutionNotRetryable = "execution_not_retryable"
	// CodeStepAttemptSuperseded refuses a retry of an older attempt.
	CodeStepAttemptSuperseded = "step_attempt_superseded"
	// CodeApprovalClosed refuses a decision on an approval closed with the run.
	CodeApprovalClosed = "approval_closed"
	// CodeRunFinished (#668) refuses a decision because the run already ended.
	CodeRunFinished = "run_finished"
	// CodeApprovalRequirementUnavailable is the retryable decide failure when
	// rebuilding the pinned requirement hits a database, network, or timeout
	// error. The approval is unchanged and nothing is recorded.
	CodeApprovalRequirementUnavailable = "approval_requirement_unavailable"
	// CodeGroupNameTaken is a workspace group display name already used in
	// the workspace, compared without regard to case. errors[].path is
	// displayName. The unique-index race maps here too.
	CodeGroupNameTaken = "group_name_taken"
	// CodeGroupMemberNotInWorkspace refuses a group member add for a user
	// who is not active or has no role binding in the workspace.
	// errors[].path is userId.
	CodeGroupMemberNotInWorkspace = "group_member_not_in_workspace"
	// CodeGroupManagedBySCIM refuses a local rename, member add or
	// remove, or delete of a group with managedBy "scim" while the
	// instance runs SCIM_GROUPS_MODE=groups. Nothing changes; change the
	// group in the identity provider instead.
	CodeGroupManagedBySCIM = "group_managed_by_scim"
	// CodeApproverNotTargeted refuses a decision on a targeted gate by a
	// caller who is not a snapshot approver, not in a snapshot group, and
	// not a non-requester admin. Nothing is recorded.
	CodeApproverNotTargeted = "approver_not_targeted"
	// CodeScimTokenLimit refuses creating a SCIM workspace token while
	// the workspace already has the maximum number of active tokens.
	CodeScimTokenLimit = "scim_token_limit"
	// CodeScimNotConfigured refuses creating a SCIM workspace token when
	// SCIM is off on the instance (no SCIM_* variable set, so no issuer
	// and default role), so a token could not provision anyone.
	CodeScimNotConfigured = "scim_not_configured"
)

// FieldError is a YAML-path validation failure returned on invalid-workflow.
type FieldError struct {
	Path    string `json:"path"`
	NodeID  string `json:"nodeId,omitempty"`
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
	Reason    string       `json:"reason,omitempty"`
	Errors    []FieldError `json:"errors,omitempty"`
	// SuggestedSlug is set only on create and import slug 409s.
	SuggestedSlug string `json:"suggestedSlug,omitempty"`
}

// WriteProblem writes an application/problem+json response. Detail must not
// include secret material or raw request bodies.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail string) {
	writeProblem(w, r, status, code, title, detail, "", nil)
}

// WriteProblemReason writes a problem document with a machine-readable reason.
func WriteProblemReason(w http.ResponseWriter, r *http.Request, status int, code, title, detail, reason string) {
	writeProblem(w, r, status, code, title, detail, reason, nil)
}

// WriteProblemErrors writes a problem document with a field-level errors array.
func WriteProblemErrors(w http.ResponseWriter, r *http.Request, status int, code, title, detail string, errors []FieldError) {
	writeProblem(w, r, status, code, title, detail, "", errors)
}

// WriteSlugConflict writes a create or import slug 409 with field errors
// and an optional suggestedSlug.
func WriteSlugConflict(w http.ResponseWriter, r *http.Request, code, detail, suggested string, errors []FieldError) {
	writeProblemDoc(w, r, http.StatusConflict, code, "Conflict", detail, "", errors, suggested)
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail, reason string, errors []FieldError) {
	writeProblemDoc(w, r, status, code, title, detail, reason, errors, "")
}

func writeProblemDoc(w http.ResponseWriter, r *http.Request, status int, code, title, detail, reason string, errors []FieldError, suggested string) {
	p := Problem{
		Type:      ProblemTypePrefix + code,
		Title:     title,
		Status:    status,
		Detail:    detail,
		Instance:  r.URL.Path,
		Code:      code,
		RequestID: RequestIDFromContext(r.Context()),
		Reason:    reason,
		Errors:    errors,

		SuggestedSlug: suggested,
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

// WriteRateLimited writes 429 rate-limited with Retry-After. Detail must
// not include secrets. retry < 1s is raised to 1 so clients always get
// a usable backoff.
func WriteRateLimited(w http.ResponseWriter, r *http.Request, retry time.Duration, detail string) {
	secs := int(retry.Seconds())
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	WriteProblem(w, r, http.StatusTooManyRequests, CodeRateLimited, "Rate Limited", detail)
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

func WriteJSON(w http.ResponseWriter, status int, payload any) {
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
		var typeErr *json.UnmarshalTypeError
		switch {
		case errors.As(err, &typeErr) && typeErr.Field != "" && typeErr.Type != nil:
			// Valid JSON with a wrong-typed field: name the field and the
			// expected type, never the value.
			// The path is cut at the first map key, since map keys are
			// chosen by the client and must not be echoed.
			field, typ := fieldPathBeforeMapKey(reflect.TypeOf(dst), typeErr.Field, typeErr.Type)
			msg := field + " must be " + jsonTypeName(typ) + "."
			WriteProblemErrors(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", msg,
				[]FieldError{{Path: field, Code: CodeInvalidType, Message: msg}})
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

// fieldPathBeforeMapKey walks the dotted json field path through t and
// stops at the first map, so a client-chosen map key is never reported.
// When it stops early the reported type is the map itself ("an object").
func fieldPathBeforeMapKey(t reflect.Type, path string, leaf reflect.Type) (string, reflect.Type) {
	segs := strings.Split(path, ".")
	for i, seg := range segs {
		for t != nil && (t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
			t = t.Elem()
		}
		if t == nil {
			return path, leaf
		}
		if t.Kind() == reflect.Map {
			if i == 0 {
				return "body", t
			}
			return strings.Join(segs[:i], "."), t
		}
		if t.Kind() != reflect.Struct {
			return path, leaf
		}
		next, ok := jsonFieldType(t, seg)
		if !ok {
			return path, leaf
		}
		t = next
	}
	return path, leaf
}

// jsonFieldType finds the struct field that decodes from json name, using
// the same case-insensitive match as encoding/json, through embedded structs.
func jsonFieldType(t reflect.Type, name string) (reflect.Type, bool) {
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" {
			continue
		}
		tagName, _, _ := strings.Cut(tag, ",")
		if f.Anonymous && tagName == "" {
			et := f.Type
			if et.Kind() == reflect.Pointer {
				et = et.Elem()
			}
			if et.Kind() == reflect.Struct {
				if ft, ok := jsonFieldType(et, name); ok {
					return ft, true
				}
			}
			continue
		}
		if !f.IsExported() {
			continue
		}
		if tagName == "" {
			tagName = f.Name
		}
		if strings.EqualFold(tagName, name) {
			return f.Type, true
		}
	}
	return nil, false
}

// CodeInvalidType is the field error code for a value of the wrong JSON type.
const CodeInvalidType = "invalid-type"

// jsonTypeName names the JSON type a Go type decodes from, with its article.
func jsonTypeName(t reflect.Type) string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "an integer"
	case reflect.Float32, reflect.Float64:
		return "a number"
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "a boolean"
	case reflect.Slice, reflect.Array:
		return "an array"
	case reflect.Map, reflect.Struct:
		return "an object"
	}
	return "a valid value"
}
