// Package buildinfo exposes non-secret process identity for health/readiness.
// Version and SHA are injected at image build via ldflags, or at runtime via
// BUILD_VERSION / BUILD_SHA. Missing or unsafe values become "dev" / "unknown"
// and never fail the process or the liveness probe.
package buildinfo

import (
	"os"
	"regexp"
	"strings"
)

const (
	DefaultVersion = "dev"
	DefaultSHA     = "unknown"

	EnvVersion = "BUILD_VERSION"
	EnvSHA     = "BUILD_SHA"
)

// Version and SHA are set at link time:
//
//	-X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.Version=…
//	-X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.SHA=…
//
// Compose and CI pass Dockerfile ARG BUILD_VERSION / BUILD_SHA into those
// ldflags. Leave them unset for `go run` / unit tests.
var (
	Version = DefaultVersion
	SHA     = DefaultSHA
)

// versionRe is a conservative release/tag/ref token. It is not a secret
// alphabet: no `/`, `=`, whitespace, or JWT-length blobs.
var versionRe = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`)

// shaRe matches a short or full git object name. Non-hex values are
// dropped so a mis-set env cannot echo a password or token.
var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)

// Info is the secret-free identity published on health/readiness.
type Info struct {
	Version string `json:"version"`
	SHA     string `json:"sha"`
}

// Resolve returns sanitized version metadata. Runtime env wins over
// ldflags so a rebuilt-without-args image can still be labeled. Empty,
// malformed, or secret-shaped values fall back to "dev" / "unknown".
func Resolve() Info {
	return Info{
		Version: firstSafe(sanitizeVersion(os.Getenv(EnvVersion)), sanitizeVersion(Version), DefaultVersion),
		SHA:     firstSafe(sanitizeSHA(os.Getenv(EnvSHA)), sanitizeSHA(SHA), DefaultSHA),
	}
}

func sanitizeVersion(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	if strings.EqualFold(v, DefaultVersion) || strings.EqualFold(v, DefaultSHA) {
		return strings.ToLower(v)
	}
	if versionRe.MatchString(v) {
		return v
	}
	return ""
}

func sanitizeSHA(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	if strings.EqualFold(v, DefaultSHA) {
		return DefaultSHA
	}
	if shaRe.MatchString(v) {
		return strings.ToLower(v)
	}
	return ""
}

func firstSafe(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
