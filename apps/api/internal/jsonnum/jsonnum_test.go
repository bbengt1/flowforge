package jsonnum

import (
	"encoding/json"
	"testing"
)

func TestDecodeKeepsOnlyInexactWholeNumbers(t *testing.T) {
	v, err := Decode([]byte(`{"a": 9007199254740993, "b": -9007199254740993, "c": 9007199254740992,
		"d": -9007199254740992, "e": 5, "f": 1.5, "g": 1e300, "h": [99999999999999999999999], "i": 9007199254740993.0}`))
	if err != nil {
		t.Fatal(err)
	}
	m := v.(map[string]any)
	want := map[string]any{
		"a": json.Number("9007199254740993"), "b": json.Number("-9007199254740993"),
		"c": float64(1 << 53), "d": float64(-(1 << 53)), "e": float64(5), "f": 1.5, "g": 1e300,
		"i": float64(9007199254740992), // not a whole literal: a double, as before
	}
	for k, w := range want {
		if m[k] != w {
			t.Fatalf("%s: %#v want %#v", k, m[k], w)
		}
	}
	if m["h"].([]any)[0] != json.Number("99999999999999999999999") {
		t.Fatalf("h: %#v", m["h"])
	}
	raw, _ := json.Marshal(m["a"])
	if string(raw) != "9007199254740993" {
		t.Fatalf("marshal %s", raw)
	}
	if _, err := Decode([]byte(`{} {}`)); err == nil {
		t.Fatal("trailing data accepted")
	}
}

func TestObjectUnmarshal(t *testing.T) {
	var s struct {
		O Object `json:"o"`
		N Object `json:"n"`
	}
	if err := json.Unmarshal([]byte(`{"o": {"x": 9007199254740993}, "n": null}`), &s); err != nil {
		t.Fatal(err)
	}
	if s.O["x"] != json.Number("9007199254740993") || s.N != nil {
		t.Fatalf("%#v", s)
	}
	if err := json.Unmarshal([]byte(`{"o": [1]}`), &s); err == nil {
		t.Fatal("non-object accepted")
	}
}
