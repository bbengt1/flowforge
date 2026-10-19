package workflow

import (
	"encoding/json"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestDecodeScalarKeepsBigIntegersExact(t *testing.T) {
	cases := map[string]any{
		"99999999999999999999":  json.Number("99999999999999999999"),
		"-99999999999999999999": json.Number("-99999999999999999999"),
		"+99999999999999999999": json.Number("99999999999999999999"),
		"9223372036854775807":   int64(9223372036854775807),
		"42":                    int64(42),
		"1.5":                   1.5,
		"1e20":                  1e20,
	}
	for src, want := range cases {
		var n yaml.Node
		if err := yaml.Unmarshal([]byte(src), &n); err != nil {
			t.Fatal(err)
		}
		if got := decodeScalar(n.Content[0]); got != want {
			t.Fatalf("%s: got %#v want %#v", src, got, want)
		}
	}
}

func TestSchemaTypeMessageArticle(t *testing.T) {
	for typ, want := range map[string]string{"integer": "an integer", "object": "an object", "array": "an array", "string": "a string", "number": "a number", "boolean": "a boolean"} {
		if got := withArticle(typ); got != want {
			t.Fatalf("%s: %q", typ, got)
		}
	}
}
