package scripts

import (
	"encoding/json"
	"strings"
	"testing"
)

// #650 E3.3 review L1: exact json.Number handling in script I/O schemas.
func TestScriptSchemaBigJSONNumber650(t *testing.T) {
	big := json.Number("9007199254740993")
	if n, ok := asInt(big); !ok || n != 9007199254740993 {
		t.Fatalf("asInt %d %v", n, ok)
	}
	if _, ok := asInt(json.Number("123456789012345678901234567890")); ok {
		t.Fatal("asInt beyond int")
	}
	if !valueMatchesType(big, "integer") || !valueMatchesType(big, "number") {
		t.Fatal("type")
	}
	if err := validateValueAgainstSchema(big, map[string]any{"type": "integer", "maximum": int64(1 << 53)}, "v"); err == nil || !strings.Contains(err.Error(), "maximum") {
		t.Fatalf("max: %v", err)
	}
	if err := validateValueAgainstSchema(big, map[string]any{"minimum": big, "maximum": big}, "v"); err != nil {
		t.Fatalf("equal: %v", err)
	}
	huge := json.Number(strings.Repeat("9", 500))
	err := validateValueAgainstSchema(huge, map[string]any{"maximum": int64(1)}, "v")
	if err == nil || !strings.Contains(err.Error(), "too large to compare exactly") || strings.Contains(err.Error(), "9999") {
		t.Fatalf("huge: %v", err)
	}
}
