package kubernetes

import (
	"errors"
	"fmt"
	"net/http"
)

// Stable engine error codes for Chloe and job outputs.
const (
	CodeInvalidManifest    = "invalid-manifest"
	CodeKindDenied         = "kind-denied"
	CodeNamespaceDenied    = "namespace-denied"
	CodeVerbDenied         = "verb-denied"
	CodeSecretForbidden    = "secret-forbidden"
	CodePolicyDenied       = "policy-denied"
	CodeRBACDenied         = "rbac-denied"
	CodeImageDenied        = "image-denied"
	CodeIngressDenied      = "ingress-denied"
	CodeWorkloadDenied     = "workload-denied"
	CodeOwnershipConflict  = "ownership-conflict"
	CodeDryRunFailed       = "dry-run-failed"
	CodeApplyFailed        = "apply-failed"
	CodeReadFailed         = "read-failed"
	CodePermissionDenied   = "forbidden"
	CodeTimeout            = "timeout"
	CodeMissingClient      = "missing-client"
	CodeHandleForbidden    = "handle-forbidden"
	CodeClusterUnreachable = "cluster-unreachable"
)

// FieldManager is the service-owned SSA manager. Callers cannot change it.
const FieldManager = "flowforge"

// DefaultTimeoutSeconds is used when the node omits timeoutSeconds.
const DefaultTimeoutSeconds = 60

// MaxTimeoutSeconds is the bounded apply/read wait.
const MaxTimeoutSeconds = 3600

// MaxManifestBytes caps YAML submitted to apply.
const MaxManifestBytes = 64 << 10

// ObservationDeferred is returned when wait=ready (full watch is E7.3).
const ObservationDeferred = "deferred-e7.3"

// EngineError is a secret-free failure returned to jobs and tests.
type EngineError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"status,omitempty"`
	Path    string `json:"path,omitempty"`
}

func (e *EngineError) Error() string {
	if e == nil {
		return ""
	}
	if e.Path != "" {
		return fmt.Sprintf("%s: %s", e.Path, e.Message)
	}
	return e.Message
}

func engineError(code, message string, status int) *EngineError {
	return &EngineError{Code: code, Message: message, Status: status}
}

func pathError(code, path, message string, status int) *EngineError {
	return &EngineError{Code: code, Path: path, Message: message, Status: status}
}

func asEngineError(err error) *EngineError {
	if err == nil {
		return nil
	}
	var ee *EngineError
	if errors.As(err, &ee) {
		return ee
	}
	return engineError(CodeApplyFailed, "Kubernetes operation failed.", http.StatusBadGateway)
}

// IsOwnershipConflict reports a server-side apply field-manager conflict.
func IsOwnershipConflict(err error) bool {
	var ee *EngineError
	return errors.As(err, &ee) && ee != nil && ee.Code == CodeOwnershipConflict
}
