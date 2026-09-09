package scripts

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
)

// ScanSource inspects authored source before it is packaged. Irredactable
// secrets fail closed; isolated token-shaped strings are treated as forbidden
// in published source (source is versioned YAML, not a redacted log).
func ScanSource(source string) error {
	if strings.TrimSpace(source) == "" {
		return engineError(CodeInvalidSource, "source is required.", http.StatusBadRequest)
	}
	res := artifact.Scan(artifact.KindFile, artifact.ClassInternal, []byte(source))
	if res.Reject != "" {
		return engineError(CodeSecretForbidden, "Secret material is not allowed in script source.", http.StatusBadRequest)
	}
	if res.Redacted && string(res.Safe) != source {
		return engineError(CodeSecretForbidden, "Secret material is not allowed in script source.", http.StatusBadRequest)
	}
	return nil
}

// ScanStatusFor reports the persistable scan status after a closed check.
func ScanStatusFor(source string) (status string, err error) {
	if err := ScanSource(source); err != nil {
		return ScanFailed, err
	}
	return ScanClean, nil
}
