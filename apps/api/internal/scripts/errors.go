package scripts

import (
	"errors"
	"fmt"
	"net/http"
)

// Persistence and pipeline errors.
var (
	ErrNotFound         = errors.New("not found")
	ErrConflict         = errors.New("conflict")
	ErrInvalid          = errors.New("invalid")
	ErrNoScope          = errors.New("workspace scope is not set")
	ErrImmutable        = errors.New("script artifacts are immutable")
	ErrMutable          = errors.New("mutable script artifacts cannot be executed")
	ErrUnscanned        = errors.New("script artifact has not been scanned")
	ErrUnsigned         = errors.New("script artifact is unsigned")
	ErrScanFailed       = errors.New("script artifact scan failed")
	ErrRevoked          = errors.New("script artifact has been revoked")
	ErrStoreUnavailable = errors.New("script artifact store is unavailable")
	ErrSigningKey       = errors.New("script signing key is not available")
	ErrIsolation        = errors.New("script isolation policy denied the run")
	ErrEgressDenied     = errors.New("script egress is not allowlisted")
	ErrMetadataDenied   = errors.New("cloud metadata service access is denied")
	ErrPackageInstall   = errors.New("runtime package installation is denied")
	ErrImageDenied      = errors.New("arbitrary or unpinned runtime images are denied")
	ErrResourceLimit    = errors.New("script exceeded pinned resource limits")
	ErrLeaseLost        = errors.New("worker lease was lost; script outcome is indeterminate")
)

// Documented engine / field codes for Chloe.
const (
	CodeInvalidSource            = "invalid-source"
	CodeInvalidEntrypoint        = "invalid-entrypoint"
	CodeInvalidRuntimeProfile    = "invalid-runtime-profile"
	CodeLanguageMismatch         = "language-mismatch"
	CodeInvalidSchema            = "invalid-schema"
	CodeSecretForbidden          = "secret-forbidden"
	CodeSizeLimit                = "size-limit"
	CodeArtifactMutable          = "artifact-mutable"
	CodeArtifactUnscanned        = "artifact-unscanned"
	CodeArtifactUnsigned         = "artifact-unsigned"
	CodeArtifactScanFailed       = "artifact-scan-failed"
	CodeArtifactRevoked          = "artifact-revoked"
	CodePermissionDenied         = "permission-denied"
	CodePolicyDenied             = "policy-denied"
	CodeIsolationDenied          = "isolation-denied"
	CodeMetadataDenied           = "metadata-denied"
	CodeEgressDenied             = "egress-denied"
	CodePackageInstallDenied     = "package-install-denied"
	CodeImageDenied              = "image-denied"
	CodeDockerSocketDenied       = "docker-socket-denied"
	CodeServiceAccountDenied     = "service-account-denied"
	CodeRootDenied               = "root-denied"
	CodeWritableRootFSDenied     = "writable-rootfs-denied"
	CodeCapabilityDenied         = "capability-denied"
	CodePrivilegeEscalation      = "privilege-escalation-denied"
	CodeResourceLimit            = "resource-limit"
	CodeIndeterminate            = "indeterminate"
	CodeRunnerNotImplemented     = "runner-not-implemented"
	CodeIONotImplemented         = "typed-io-not-implemented"
	CodeRevocationNotImplemented = "revocation-not-implemented"
)

// EngineError is a secret-free failure returned to publish/execute callers.
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

func asEngineError(err error) *EngineError {
	if err == nil {
		return nil
	}
	var ee *EngineError
	if errors.As(err, &ee) {
		return ee
	}
	switch {
	case errors.Is(err, ErrMutable):
		return engineError(CodeArtifactMutable, "Mutable or draft script artifacts cannot be executed.", http.StatusBadRequest)
	case errors.Is(err, ErrUnscanned):
		return engineError(CodeArtifactUnscanned, "Unscanned script artifacts cannot be executed.", http.StatusBadRequest)
	case errors.Is(err, ErrUnsigned):
		return engineError(CodeArtifactUnsigned, "Unsigned script artifacts cannot be executed.", http.StatusBadRequest)
	case errors.Is(err, ErrScanFailed):
		return engineError(CodeArtifactScanFailed, "Script artifacts with a failed scan cannot be executed.", http.StatusBadRequest)
	case errors.Is(err, ErrRevoked):
		return engineError(CodeArtifactRevoked, "Revoked script artifacts cannot be executed.", http.StatusConflict)
	case errors.Is(err, ErrMetadataDenied):
		return engineError(CodeMetadataDenied, "Cloud instance metadata access is denied.", http.StatusForbidden)
	case errors.Is(err, ErrEgressDenied):
		return engineError(CodeEgressDenied, "Destination is outside the script egress allowlist.", http.StatusForbidden)
	case errors.Is(err, ErrPackageInstall):
		return engineError(CodePackageInstallDenied, "Runtime package installation is denied.", http.StatusForbidden)
	case errors.Is(err, ErrImageDenied):
		return engineError(CodeImageDenied, "Arbitrary or mutable runtime images are denied.", http.StatusBadRequest)
	case errors.Is(err, ErrResourceLimit):
		return engineError(CodeResourceLimit, "CPU, memory, process, or time limit was exceeded.", http.StatusBadRequest)
	case errors.Is(err, ErrLeaseLost):
		return engineError(CodeIndeterminate, "Worker lease was lost; the script is not retried until a verification hook resolves it.", http.StatusConflict)
	case errors.Is(err, ErrIsolation):
		return engineError(CodeIsolationDenied, "The isolated runner denied the requested execution environment.", http.StatusForbidden)
	case errors.Is(err, ErrNotFound):
		return engineError(CodeInvalidRuntimeProfile, "Script artifact was not found in this workspace.", http.StatusNotFound)
	case errors.Is(err, ErrInvalid), errors.Is(err, ErrSigningKey):
		return engineError(CodeInvalidSource, "The script package is not valid.", http.StatusBadRequest)
	default:
		return engineError(CodeInvalidSource, "Script publish or verification failed.", http.StatusBadRequest)
	}
}
