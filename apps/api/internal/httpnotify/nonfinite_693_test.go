package httpnotify

import (
	"math"
	"testing"
)

func TestSchemaBoundsRefuseNonFinite(t *testing.T) {
	schema := map[string]any{"minimum": 0, "maximum": 10}
	for _, v := range []any{math.Inf(1), math.Inf(-1), math.NaN(), float32(math.Inf(1))} {
		if schemaAllowsValue(schema, v, 0) {
			t.Fatalf("%v passed a min/max schema without a type", v)
		}
	}
	if !schemaAllowsValue(schema, 5.0, 0) {
		t.Fatal("finite value in range refused")
	}
	if !schemaAllowsValue(map[string]any{}, math.Inf(1), 0) {
		t.Fatal("schema without bounds should not start checking finiteness")
	}
}
