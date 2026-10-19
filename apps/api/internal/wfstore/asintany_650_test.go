package wfstore

import (
	"encoding/json"
	"testing"
)

// #650 E3.3 review L1: asIntAny reads an exact json.Number.
func TestAsIntAnyJSONNumber650(t *testing.T) {
	if n, ok := asIntAny(json.Number("3")); !ok || n != 3 {
		t.Fatalf("%d %v", n, ok)
	}
	if n, ok := asIntAny(json.Number("9007199254740993")); !ok || n != 9007199254740993 {
		t.Fatalf("big %d %v", n, ok)
	}
	for _, bad := range []json.Number{"123456789012345678901234567890", "1.5", "1e3"} {
		if _, ok := asIntAny(bad); ok {
			t.Fatalf("%s accepted", bad)
		}
	}
	// A step whose policy snapshot carries a json.Number maxAttempts reads it.
	if n, ok := asIntAny(unmarshalObject([]byte(`{"m": 9007199254740993}`))["m"]); !ok || n != 9007199254740993 {
		t.Fatalf("decoded %d %v", n, ok)
	}
}
