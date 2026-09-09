// Package artifact implements upload gates, encrypted object storage, and
// short-lived download helpers for execution artifacts (E5.3).
package artifact

import (
	"bytes"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	KindLog    = "log"
	KindOutput = "output"
	KindFile   = "file"

	ClassPublic       = "public"
	ClassInternal     = "internal"
	ClassConfidential = "confidential"

	DefaultMaxBytes    = 1 << 20 // 1 MiB
	DefaultLogMaxBytes = 256 << 10
	DefaultOutputBytes = 16 << 10
	DefaultLogLines    = 200
	MaxFilenameLen     = 128
)

var (
	pemPrivateKey = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	kubeconfigDoc = regexp.MustCompile(`(?is)apiVersion:\s*v1[\s\S]{0,400}kind:\s*Config[\s\S]{0,800}(users:|user:)`)
	k8sSecretDoc  = regexp.MustCompile(`(?is)kind:\s*Secret[\s\S]{0,400}(data:|stringData:)`)
	awsSecret     = regexp.MustCompile(`(?i)aws_secret_access_key\s*[=:]\s*\S+`)
	githubToken   = regexp.MustCompile(`(?i)\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b`)
	bearerToken   = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9\-._~+/]+=*`)
	jwtToken      = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
)

// ErrUnsafe is returned when content cannot be safely retained.
const ErrUnsafeMessage = "artifact content cannot be safely retained"

// ScanResult is the upload-gate outcome. Rejected content must not be stored.
type ScanResult struct {
	Safe     []byte
	Redacted bool
	Reject   string
}

var allowedTypes = map[string]struct{}{
	"text/plain":                {},
	"text/plain; charset=utf-8": {},
	"application/json":          {},
	"application/octet-stream":  {},
}

// AllowedContentType reports whether the type may be stored after a scan.
func AllowedContentType(ct string) bool {
	ct = strings.ToLower(strings.TrimSpace(ct))
	if ct == "" {
		return false
	}
	if _, ok := allowedTypes[ct]; ok {
		return true
	}
	if strings.HasPrefix(ct, "text/plain") {
		return true
	}
	return false
}

// SanitizeFilename strips path components and control characters.
func SanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	var b strings.Builder
	for _, r := range name {
		if r < 32 || r == 127 {
			continue
		}
		b.WriteRune(r)
	}
	name = strings.TrimSpace(b.String())
	if name == "" || name == "." || name == ".." {
		return "artifact"
	}
	if utf8.RuneCountInString(name) > MaxFilenameLen {
		runes := []rune(name)
		name = string(runes[:MaxFilenameLen])
	}
	return name
}

// Scan inspects payload before upload. Irredactable secrets (private keys,
// kubeconfig, Kubernetes Secret manifests) are rejected. Isolated token-shaped
// strings in logs are replaced with [redacted] and may be stored.
func Scan(kind, classification string, payload []byte) ScanResult {
	kind = strings.TrimSpace(kind)
	classification = strings.TrimSpace(classification)
	if kind != KindLog && kind != KindOutput && kind != KindFile {
		return ScanResult{Reject: "unknown artifact kind"}
	}
	switch classification {
	case ClassPublic, ClassInternal, ClassConfidential:
	case "secret", "restricted":
		return ScanResult{Reject: ErrUnsafeMessage}
	default:
		return ScanResult{Reject: "unknown content classification"}
	}
	if len(payload) == 0 {
		return ScanResult{Reject: "empty artifact content"}
	}
	if irredactable(payload) {
		return ScanResult{Reject: ErrUnsafeMessage}
	}
	safe, changed := redactPayload(payload)
	if irredactable(safe) {
		return ScanResult{Reject: ErrUnsafeMessage}
	}
	return ScanResult{Safe: safe, Redacted: changed || true}
}

func irredactable(payload []byte) bool {
	if pemPrivateKey.Match(payload) {
		return true
	}
	if kubeconfigDoc.Match(payload) {
		return true
	}
	if k8sSecretDoc.Match(payload) {
		return true
	}
	if awsSecret.Match(payload) {
		return true
	}
	lower := bytes.ToLower(payload)
	if bytes.Contains(lower, []byte("dek_envelope")) || bytes.Contains(lower, []byte("ciphertext")) {
		if bytes.Contains(lower, []byte("credential")) || bytes.Contains(lower, []byte("kubeconfig")) {
			return true
		}
	}
	return false
}

func redactPayload(payload []byte) ([]byte, bool) {
	s := string(payload)
	orig := s
	s = bearerToken.ReplaceAllString(s, "[redacted]")
	s = githubToken.ReplaceAllString(s, "[redacted]")
	s = jwtToken.ReplaceAllString(s, "[redacted]")
	return []byte(s), s != orig
}

// BoundText returns at most maxBytes of text, reporting truncation.
func BoundText(s string, maxBytes int) (string, bool) {
	if maxBytes <= 0 {
		maxBytes = DefaultOutputBytes
	}
	if len(s) <= maxBytes {
		return s, false
	}
	return s[:maxBytes], true
}

// BoundLines returns a window of lines capped by count and maxBytes.
func BoundLines(text string, offset, limit, maxBytes int) (lines []string, next int, truncated bool) {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 || limit > DefaultLogLines {
		limit = DefaultLogLines
	}
	if maxBytes <= 0 {
		maxBytes = DefaultOutputBytes
	}
	all := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if offset > len(all) {
		return []string{}, offset, false
	}
	used := 0
	i := offset
	for i < len(all) && len(lines) < limit {
		line := all[i]
		if used+len(line)+1 > maxBytes {
			truncated = true
			break
		}
		lines = append(lines, line)
		used += len(line) + 1
		i++
	}
	if i < len(all) {
		truncated = true
	}
	if lines == nil {
		lines = []string{}
	}
	return lines, i, truncated
}
