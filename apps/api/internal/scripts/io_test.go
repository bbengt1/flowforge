package scripts

import (
	"strings"
	"testing"
)

func TestValidateExecutionInputRejectsSchemaAndSize(t *testing.T) {
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"name"},
		"properties": map[string]any{
			"name": map[string]any{"type": "string", "maxLength": 8},
		},
	}
	if err := ValidateExecutionInput(map[string]any{"name": "ok"}, schema); err != nil {
		t.Fatalf("valid input: %v", err)
	}
	if err := ValidateExecutionInput(map[string]any{"extra": true}, schema); err == nil {
		t.Fatal("unknown field must fail")
	} else if ee := asEngineError(err); ee.Code != CodeInvalidSchema {
		t.Fatalf("schema code = %s", ee.Code)
	}
	if err := ValidateExecutionInput(map[string]any{"name": strings.Repeat("n", 9)}, schema); err == nil {
		t.Fatal("maxLength must fail")
	}
	big := map[string]any{"name": strings.Repeat("x", MaxInputBytes)}
	if err := ValidateExecutionInput(big, schema); err == nil {
		t.Fatal("oversize input must fail")
	} else if ee := asEngineError(err); ee.Code != CodeSizeLimit {
		t.Fatalf("size code = %s (%v)", ee.Code, err)
	}
	if err := ValidateExecutionInput(map[string]any{"token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}, nil); err == nil {
		t.Fatal("secret input must fail")
	} else if ee := asEngineError(err); ee.Code != CodeSecretForbidden {
		t.Fatalf("secret code = %s", ee.Code)
	}
}

func TestValidateExecutionOutputRejectsOversizeAndSecrets(t *testing.T) {
	schema := map[string]any{"type": "object", "properties": map[string]any{"status": map[string]any{"type": "string"}}}
	obj, safe, err := ValidateExecutionOutput(`{"status":"ok"}`, schema)
	if err != nil || obj["status"] != "ok" || safe == "" {
		t.Fatalf("valid output: %v %+v", err, obj)
	}
	huge := `{"status":"` + strings.Repeat("o", MaxOutputBytes) + `"}`
	if _, _, err := ValidateExecutionOutput(huge, schema); err == nil {
		t.Fatal("oversize output must fail")
	} else if ee := asEngineError(err); ee.Code != CodeOutputTooLarge && ee.Code != CodeSizeLimit {
		t.Fatalf("oversize code = %s", ee.Code)
	}
	if _, _, err := ValidateExecutionOutput(`{"token":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}`, nil); err == nil {
		t.Fatal("secret output must fail")
	}
	if _, _, err := ValidateExecutionOutput("not-json", schema); err == nil {
		t.Fatal("non-json with schema must fail")
	}
}
