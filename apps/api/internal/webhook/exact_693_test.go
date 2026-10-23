package webhook

import (
	"encoding/json"
	"testing"
)

func TestParseAndCloneKeepBigIntegersExact(t *testing.T) {
	obj, err := ParseJSONObject([]byte(`{"id":9007199254740993,"n":42,"f":1.5,"s":"12345678901234567","o":{"id":12345678901234567}}`))
	if err != nil {
		t.Fatal(err)
	}
	if obj["n"] != float64(42) || obj["f"] != 1.5 {
		t.Fatalf("ordinary numbers changed shape: %#v", obj)
	}
	for _, v := range []map[string]any{obj, cloneObject(obj)} {
		raw, _ := json.Marshal(v)
		want := `{"f":1.5,"id":9007199254740993,"n":42,"o":{"id":12345678901234567},"s":"12345678901234567"}`
		if string(raw) != want {
			t.Fatalf("got %s", raw)
		}
	}
	mapped, err := MapFields(obj, nil)
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(mapped["id"]); string(raw) != "9007199254740993" {
		t.Fatalf("mapped id = %s", raw)
	}
	for _, bad := range []string{`{}x`, `{} {}`, `[1]`, `null`, `{"a":`} {
		if _, err := ParseJSONObject([]byte(bad)); err != ErrInvalid {
			t.Fatalf("%q: err = %v", bad, err)
		}
	}
}
