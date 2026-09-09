package scripts

import (
	"strings"
)

// RedactSource replaces isolated token-shaped strings. Irredactable material
// is not rewritten — callers must reject it via ScanSource first.
func RedactSource(source string) string {
	if irredactableSecret([]byte(source)) {
		return ""
	}
	safe, _ := redactTokens(source)
	return safe
}

// AuditMetadata is the secret-free record written on publish.
func AuditMetadata(in PublishInput, digest, scanStatus string) map[string]any {
	out := map[string]any{
		"language":        strings.ToLower(strings.TrimSpace(in.Language)),
		"entrypoint":      strings.TrimSpace(in.Entrypoint),
		"digest":          digest,
		"scanStatus":      scanStatus,
		"sourceBytes":     len(in.Source),
		"hasInputSchema":  in.InputSchema != nil,
		"hasOutputSchema": in.OutputSchema != nil,
	}
	if in.RuntimeProfileID != "" {
		out["runtimeProfileId"] = in.RuntimeProfileID
	}
	if in.RuntimeProfileDigest != "" {
		out["runtimeProfileDigest"] = in.RuntimeProfileDigest
	}
	if in.NodeID != "" {
		out["nodeId"] = in.NodeID
	}
	return out
}
