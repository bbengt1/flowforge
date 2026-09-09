package scripts

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

// Package builds the canonical content-addressed payload and digest.
func Package(in PublishInput) (PackagePayload, []byte, string, error) {
	if err := ValidateSource(in.Language, in.Source, in.Entrypoint); err != nil {
		return PackagePayload{}, nil, "", err
	}
	payload := PackagePayload{
		APIVersion:           PackageAPIVersion,
		Kind:                 PackageKind,
		Language:             strings.ToLower(strings.TrimSpace(in.Language)),
		Entrypoint:           strings.TrimSpace(in.Entrypoint),
		Source:               in.Source,
		InputSchema:          cloneMap(in.InputSchema),
		OutputSchema:         cloneMap(in.OutputSchema),
		RuntimeProfileDigest: strings.TrimSpace(in.RuntimeProfileDigest),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return PackagePayload{}, nil, "", engineError(CodeInvalidSource, "script package could not be serialized.", http.StatusBadRequest)
	}
	sum := sha256.Sum256(raw)
	return payload, raw, "sha256:" + hex.EncodeToString(sum[:]), nil
}

func cloneMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}
