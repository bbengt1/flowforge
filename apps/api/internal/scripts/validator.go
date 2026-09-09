package scripts

import (
	"net/http"
	"strings"
)

// ValidatePublishInput is the fail-closed publish gate: source, entrypoint,
// runtime profile, declared I/O schema shape, secrets, and size limits.
func ValidatePublishInput(in PublishInput) error {
	lang := strings.ToLower(strings.TrimSpace(in.Language))
	if in.NodeType != "" {
		want := LanguageForNode(in.NodeType)
		if want == "" {
			return engineError(CodeInvalidSource, "node type must be script.python or script.go.", http.StatusBadRequest)
		}
		if lang == "" {
			lang = want
			in.Language = want
		} else if lang != want {
			return engineError(CodeLanguageMismatch, "node type and language must match.", http.StatusBadRequest)
		}
	}
	if err := ValidateSource(lang, in.Source, in.Entrypoint); err != nil {
		return err
	}
	if err := ScanSource(in.Source); err != nil {
		return err
	}
	if strings.TrimSpace(in.RuntimeProfileID) == "" {
		return engineError(CodeInvalidRuntimeProfile, "runtimeProfileId is required.", http.StatusBadRequest)
	}
	if err := ValidateRuntimeProfile(lang, in.RuntimeProfile); err != nil {
		return err
	}
	if in.TimeoutSeconds != 0 && (in.TimeoutSeconds < MinTimeoutSeconds || in.TimeoutSeconds > MaxTimeoutSeconds) {
		return engineError(CodeSizeLimit, "timeoutSeconds must be between 1 and 3600.", http.StatusBadRequest)
	}
	if in.MemoryMiB != 0 && (in.MemoryMiB < MinMemoryMiB || in.MemoryMiB > MaxMemoryMiB) {
		return engineError(CodeSizeLimit, "memoryMiB must be between 32 and 2048.", http.StatusBadRequest)
	}
	if in.CPUMillis != 0 && (in.CPUMillis < MinCPUMillis || in.CPUMillis > MaxCPUMillis) {
		return engineError(CodeSizeLimit, "cpuMillis is out of range.", http.StatusBadRequest)
	}
	if in.Processes != 0 && (in.Processes < MinProcesses || in.Processes > MaxProcesses) {
		return engineError(CodeSizeLimit, "processes is out of range.", http.StatusBadRequest)
	}
	if err := ValidateDeclaredSchema(in.InputSchema, "inputSchema"); err != nil {
		return err
	}
	if err := RequireObjectRoot(in.InputSchema, "inputSchema"); err != nil {
		return err
	}
	if err := ValidateDeclaredSchema(in.OutputSchema, "outputSchema"); err != nil {
		return err
	}
	if err := RequireObjectRoot(in.OutputSchema, "outputSchema"); err != nil {
		return err
	}
	if err := ValidateRetryDeclaration(in.RetryWith); err != nil {
		return err
	}
	return nil
}

var allowedSchemaKeys = map[string]bool{
	"type": true, "properties": true, "required": true, "additionalProperties": true,
	"items": true, "enum": true, "maxLength": true, "maxItems": true,
	"maxProperties": true, "minimum": true, "maximum": true, "classification": true,
}

var allowedSchemaTypes = map[string]bool{
	"object": true, "string": true, "integer": true, "boolean": true, "array": true, "number": true,
}

// ValidateDeclaredSchema checks the documented JSON Schema subset. Nil is ok.
func ValidateDeclaredSchema(schema map[string]any, path string) error {
	if schema == nil {
		return nil
	}
	return validateSchemaShape(schema, path, 0)
}

// RequireObjectRoot keeps persisted I/O aligned with the result/input object ports.
// A declared (non-nil) schema must set type to the string "object".
func RequireObjectRoot(schema map[string]any, path string) error {
	if schema == nil {
		return nil
	}
	s, ok := schema["type"].(string)
	if !ok || s != "object" {
		return &EngineError{Code: CodeInvalidSchema, Message: path + " type must be object.", Status: http.StatusBadRequest, Path: path}
	}
	return nil
}

func validateSchemaShape(schema map[string]any, path string, depth int) error {
	if depth > 8 {
		return &EngineError{Code: CodeInvalidSchema, Message: "Schema exceeds the depth limit of 8.", Status: http.StatusBadRequest, Path: path}
	}
	for k := range schema {
		if !allowedSchemaKeys[k] {
			return &EngineError{Code: CodeInvalidSchema, Message: "Unknown schema keyword " + k + ".", Status: http.StatusBadRequest, Path: path}
		}
	}
	if raw, ok := schema["type"]; ok {
		s, ok := raw.(string)
		if !ok || !allowedSchemaTypes[s] {
			return &EngineError{Code: CodeInvalidSchema, Message: "schema.type must be object, string, integer, boolean, array, or number.", Status: http.StatusBadRequest, Path: path}
		}
	}
	if raw, ok := schema["properties"].(map[string]any); ok {
		if len(raw) > 32 {
			return &EngineError{Code: CodeInvalidSchema, Message: "schema.properties exceeds 32 fields.", Status: http.StatusBadRequest, Path: path}
		}
		for name, child := range raw {
			m, ok := child.(map[string]any)
			if !ok {
				return &EngineError{Code: CodeInvalidSchema, Message: "Each property schema must be an object.", Status: http.StatusBadRequest, Path: path + ".properties." + name}
			}
			if err := validateSchemaShape(m, path+".properties."+name, depth+1); err != nil {
				return err
			}
		}
	}
	if raw, ok := schema["items"].(map[string]any); ok {
		if err := validateSchemaShape(raw, path+".items", depth+1); err != nil {
			return err
		}
	}
	return nil
}

// NodeSpec is the workflow-node projection the publish pipeline needs.
type NodeSpec struct {
	ID   string
	Type string
	With map[string]any
}

// InputFromNode extracts a PublishInput from a script node spec.
func InputFromNode(node NodeSpec, profileID, profileVersionID, profileDigest string, profileSpec map[string]any) (PublishInput, error) {
	lang := LanguageForNode(node.Type)
	if lang == "" {
		return PublishInput{}, engineError(CodeInvalidSource, "node type must be script.python or script.go.", http.StatusBadRequest)
	}
	source, _ := node.With["source"].(string)
	entrypoint, _ := node.With["entrypoint"].(string)
	in := PublishInput{
		Language:                lang,
		Source:                  source,
		Entrypoint:              entrypoint,
		RuntimeProfileID:        strings.TrimSpace(profileID),
		RuntimeProfileVersionID: strings.TrimSpace(profileVersionID),
		RuntimeProfileDigest:    strings.TrimSpace(profileDigest),
		RuntimeProfile:          profileSpec,
		NodeID:                  node.ID,
		NodeType:                node.Type,
	}
	if raw, ok := node.With["runtimeProfileId"].(string); ok && in.RuntimeProfileID == "" {
		in.RuntimeProfileID = strings.TrimSpace(raw)
	}
	if v, ok := asInt(node.With["timeoutSeconds"]); ok {
		in.TimeoutSeconds = v
	}
	if v, ok := asInt(node.With["memoryMiB"]); ok {
		in.MemoryMiB = v
	}
	if v, ok := asInt(node.With["cpuMillis"]); ok {
		in.CPUMillis = v
	}
	if v, ok := asInt(node.With["processes"]); ok {
		in.Processes = v
	}
	if raw, ok := node.With["inputSchema"].(map[string]any); ok {
		in.InputSchema = raw
	}
	if raw, ok := node.With["outputSchema"].(map[string]any); ok {
		in.OutputSchema = raw
	}
	in.RetryWith = node.With
	return in, nil
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	}
	return 0, false
}
