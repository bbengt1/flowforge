package scripts

import (
	"errors"
	"math"
	"testing"
)

func TestSchemaBoundsRefuseNonFinite(t *testing.T) {
	for _, key := range []string{"minimum", "maximum"} {
		schema := map[string]any{key: 0}
		for _, v := range []any{math.Inf(1), math.Inf(-1), math.NaN()} {
			err := validateValueAgainstSchema(v, schema, "input.n")
			var ee *EngineError
			if !errors.As(err, &ee) || ee.Code != CodeInvalidSchema || ee.Message != "Value is not a finite number for schema."+key+"." {
				t.Fatalf("%s %v: err = %v", key, v, err)
			}
		}
	}
	if err := validateValueAgainstSchema(5.0, map[string]any{"minimum": 0, "maximum": 10}, "input.n"); err != nil {
		t.Fatal(err)
	}
}

func TestSchemaTypeMessageArticle(t *testing.T) {
	err := validateValueAgainstSchema("x", map[string]any{"type": "integer"}, "input.n")
	var ee *EngineError
	if !errors.As(err, &ee) || ee.Message != "Value is not an integer." {
		t.Fatalf("err = %v", err)
	}
}
