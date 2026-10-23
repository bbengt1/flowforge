package httpnotify

import (
	"encoding/json"
	"strings"
	"testing"
)

// #650 E3.3 review L1: exact json.Number handling in notify schemas.
func TestNotifySchemaBigJSONNumber650(t *testing.T) {
	big := json.Number("9007199254740993")
	if n, err := asInt(big); err != nil || n != 9007199254740993 {
		t.Fatalf("asInt %d %v", n, err)
	}
	if _, err := asInt(json.Number("123456789012345678901234567890")); err == nil {
		t.Fatal("asInt beyond int")
	}
	if !valueMatchesSchemaType(big, "integer") || !valueMatchesSchemaType(big, "number") {
		t.Fatal("type")
	}
	if schemaAllowsValue(map[string]any{"type": "integer", "maximum": int64(1 << 53)}, big, 0) {
		t.Fatal("max not exact")
	}
	if !schemaAllowsValue(map[string]any{"minimum": big, "maximum": big}, big, 0) {
		t.Fatal("equal bounds")
	}
	if schemaAllowsValue(map[string]any{"maximum": int64(1)}, json.Number(strings.Repeat("9", 500)), 0) {
		t.Fatal("huge allowed")
	}
}
