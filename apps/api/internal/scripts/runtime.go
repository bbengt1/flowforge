package scripts

import (
	"net/http"
	"regexp"
	"strings"
)

var digestRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ValidateRuntimeProfile checks a pinned ops-config runtime_profile spec.
// Images and lockfiles must already be digest-pinned (E4.2).
func ValidateRuntimeProfile(language string, spec map[string]any) error {
	if spec == nil {
		return engineError(CodeInvalidRuntimeProfile, "a published runtime profile is required.", http.StatusBadRequest)
	}
	lang, _ := spec["language"].(string)
	lang = strings.ToLower(strings.TrimSpace(lang))
	want := strings.ToLower(strings.TrimSpace(language))
	if lang == "" || (want != "" && lang != want) {
		return engineError(CodeLanguageMismatch, "runtime profile language must match the script node.", http.StatusBadRequest)
	}
	image, _ := spec["imageDigest"].(string)
	if !digestRE.MatchString(strings.TrimSpace(image)) {
		return engineError(CodeInvalidRuntimeProfile, "runtime profile imageDigest must be sha256:<hex>.", http.StatusBadRequest)
	}
	lock, _ := spec["dependencyLockDigest"].(string)
	if !digestRE.MatchString(strings.TrimSpace(lock)) {
		return engineError(CodeInvalidRuntimeProfile, "runtime profile dependencyLockDigest must be sha256:<hex>.", http.StatusBadRequest)
	}
	limits, _ := spec["limits"].(map[string]any)
	if limits == nil {
		return engineError(CodeInvalidRuntimeProfile, "runtime profile limits are required.", http.StatusBadRequest)
	}
	for _, key := range []string{"cpuMillis", "memoryMib", "timeoutSeconds", "processes"} {
		if _, ok := limits[key]; !ok {
			return engineError(CodeInvalidRuntimeProfile, "runtime profile limits."+key+" is required.", http.StatusBadRequest)
		}
	}
	if raw, ok := spec["egress"]; ok && raw != nil {
		m, ok := raw.(map[string]any)
		if !ok {
			return engineError(CodeInvalidRuntimeProfile, "runtime profile egress must be an object.", http.StatusBadRequest)
		}
		if _, err := ParseEgressPolicy(m); err != nil {
			return err
		}
	}
	return nil
}

// ProfileLanguage returns the pinned language or empty.
func ProfileLanguage(spec map[string]any) string {
	if spec == nil {
		return ""
	}
	lang, _ := spec["language"].(string)
	return strings.ToLower(strings.TrimSpace(lang))
}
