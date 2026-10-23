package ssh

import (
	"encoding/json"
	"testing"
)

// #650 E3.3 review L1: asInt reads an exact json.Number.
func TestAsIntJSONNumber650(t *testing.T) {
	if n, err := asInt(json.Number("30")); err != nil || n != 30 {
		t.Fatalf("%d %v", n, err)
	}
	if _, err := asInt(json.Number("123456789012345678901234567890")); err == nil {
		t.Fatal("beyond int accepted")
	}
	if _, err := asInt(json.Number("1.5")); err == nil {
		t.Fatal("fraction accepted")
	}
}
