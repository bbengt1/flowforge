package scripts

import (
	"strings"
)

func redactObject(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		if secretInputKeys[strings.ToLower(strings.ReplaceAll(k, "-", ""))] {
			out[k] = "[redacted]"
			continue
		}
		switch n := v.(type) {
		case string:
			out[k] = RedactSource(n)
		case map[string]any:
			out[k] = redactObject(n)
		default:
			out[k] = v
		}
	}
	return out
}

func redactEnv(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		if !allowedRuntimeEnv[k] {
			continue
		}
		out[k] = RedactSource(v)
	}
	return out
}

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
