package kubernetes

import (
	"encoding/json"
	"testing"
)

// #650 E3.3 review L1: intField reads an exact json.Number.
func TestIntFieldJSONNumber650(t *testing.T) {
	m := map[string]any{"a": json.Number("9007199254740993"), "b": json.Number("123456789012345678901234567890")}
	if n, ok := intField(m, "a"); !ok || n != 9007199254740993 {
		t.Fatalf("%d %v", n, ok)
	}
	if _, ok := intField(m, "b"); ok {
		t.Fatal("beyond int64 accepted")
	}
}
