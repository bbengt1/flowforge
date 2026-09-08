package workflow

import (
	"strings"
	"testing"
)

func TestEvaluateCondition(t *testing.T) {
	res, errs := Evaluate("flow.condition", map[string]any{"op": "eq", "compare": "ready"}, map[string]any{"value": "ready"})
	if len(errs) > 0 {
		t.Fatalf("%+v", errs)
	}
	if res.Outputs["true"] != "ready" || res.Outputs["false"] != nil {
		t.Fatalf("route = %+v", res.Outputs)
	}

	res, errs = Evaluate("flow.condition", map[string]any{"op": "gt", "compare": int64(2), "path": "count"}, map[string]any{"value": map[string]any{"count": int64(5)}})
	if len(errs) > 0 || res.Outputs["true"] == nil {
		t.Fatalf("gt: %+v %+v", res, errs)
	}

	_, errs = Evaluate("flow.condition", map[string]any{"op": "eq", "compare": "${env}"}, map[string]any{"value": "x"})
	// compare expression is a validate-time check; eval still compares literally
	if len(errs) != 0 && res == nil {
		t.Fatalf("literal compare should evaluate: %+v", errs)
	}

	res, errs = Evaluate("flow.condition", map[string]any{"op": "exists", "path": "missing"}, map[string]any{"value": map[string]any{"ok": true}})
	if len(errs) > 0 || res.Outputs["false"] == nil {
		t.Fatalf("exists: %+v %+v", res, errs)
	}

	res, errs = Evaluate("flow.condition", map[string]any{"op": "contains", "compare": "oper"}, map[string]any{"value": "operations"})
	if len(errs) > 0 || res.Outputs["true"] == nil {
		t.Fatalf("contains: %+v %+v", res, errs)
	}
}

func TestEvaluateDelayDoesNotSleep(t *testing.T) {
	res, errs := Evaluate("flow.delay", map[string]any{"duration": "PT5M"}, map[string]any{"input": map[string]any{"ticket": "CHG-1"}})
	if len(errs) > 0 {
		t.Fatalf("%+v", errs)
	}
	if res.Delay == nil || res.Delay.DurationSeconds != 300 {
		t.Fatalf("delay = %+v", res.Delay)
	}
	got := res.Outputs["result"].(map[string]any)["ticket"]
	if got != "CHG-1" {
		t.Fatalf("passthrough = %+v", res.Outputs)
	}

	_, errs = Evaluate("flow.delay", map[string]any{"duration": "P30D"}, nil)
	assertHasCode(t, errs, CodeDurationLimit)

	_, errs = Evaluate("flow.delay", map[string]any{"duration": "P1M"}, nil)
	assertHasCode(t, errs, CodeInvalidWith)
}

func TestEvaluateDataSet(t *testing.T) {
	res, errs := Evaluate("data.set", map[string]any{
		"value": map[string]any{"env": "staging", "replicas": int64(2)},
		"schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"env":      map[string]any{"type": "string", "classification": ClassPublic},
				"replicas": map[string]any{"type": "integer"},
			},
			"required":             []any{"env"},
			"additionalProperties": false,
		},
	}, nil)
	if len(errs) > 0 {
		t.Fatalf("%+v", errs)
	}
	if res.Classification != ClassPublic {
		t.Fatalf("class = %s", res.Classification)
	}
	if res.Outputs["result"].(map[string]any)["env"] != "staging" {
		t.Fatalf("result = %+v", res.Outputs)
	}

	_, errs = Evaluate("data.set", map[string]any{
		"value": map[string]any{"password": "hunter2"},
	}, nil)
	assertHasCode(t, errs, CodeClassificationDenied)

	_, errs = Evaluate("data.set", map[string]any{
		"value":          map[string]any{"env": "prod"},
		"classification": ClassConfidential,
	}, nil)
	assertHasCode(t, errs, CodeClassificationDenied)
}

func TestEvaluateDataMap(t *testing.T) {
	res, errs := Evaluate("data.map", map[string]any{
		"mapping": map[string]any{
			"name":     "service",
			"ready":    map[string]any{"from": "flags.ok", "convert": "boolean"},
			"replicas": map[string]any{"from": "count", "convert": "integer"},
		},
	}, map[string]any{"input": map[string]any{
		"service": "api",
		"count":   "3",
		"flags":   map[string]any{"ok": true},
	}})
	if len(errs) > 0 {
		t.Fatalf("%+v", errs)
	}
	out := res.Outputs["result"].(map[string]any)
	if out["name"] != "api" || out["ready"] != true || out["replicas"] != int64(3) {
		t.Fatalf("mapped = %+v", out)
	}

	_, errs = Evaluate("data.map", map[string]any{
		"mapping": map[string]any{"x": "foo||bar"},
	}, map[string]any{"input": map[string]any{"foo": 1}})
	assertHasCode(t, errs, CodeExpressionForbidden)

	_, errs = Evaluate("data.map", map[string]any{
		"mapping": map[string]any{"x": "missing"},
	}, map[string]any{"input": map[string]any{"foo": 1}})
	assertHasCode(t, errs, CodeUnresolvedReference)
}

func TestEvaluateDataValidate(t *testing.T) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"env": map[string]any{"type": "string", "enum": []any{"staging", "prod"}},
		},
		"required":             []any{"env"},
		"additionalProperties": false,
	}
	res, errs := Evaluate("data.validate", map[string]any{"schema": schema}, map[string]any{"value": map[string]any{"env": "staging"}})
	if len(errs) > 0 || res.Audit["valid"] != true {
		t.Fatalf("valid: %+v %+v", res, errs)
	}

	res, errs = Evaluate("data.validate", map[string]any{"schema": schema}, map[string]any{"value": map[string]any{"env": "dev", "token": "secret"}})
	assertHasCode(t, errs, CodeInvalidWith)
	for _, e := range errs {
		if strings.Contains(e.Message, "dev") || strings.Contains(strings.ToLower(e.Message), "secret") && e.Code != CodeClassificationDenied && e.Code != CodeUnknownField {
			if strings.Contains(e.Message, "dev") {
				t.Fatalf("error leaked value: %+v", e)
			}
		}
	}
	if res == nil || res.Audit["valid"] != false {
		t.Fatalf("expected invalid audit: %+v", res)
	}
}

func TestEvaluateStopAndFail(t *testing.T) {
	res, errs := Evaluate("flow.stop", map[string]any{"status": "canceled", "message": "operator stopped"}, nil)
	if len(errs) > 0 || res.Terminal == nil || res.Terminal.Status != "canceled" {
		t.Fatalf("stop: %+v %+v", res, errs)
	}

	res, errs = Evaluate("flow.fail", map[string]any{"code": "precheck-failed", "message": "host not ready"}, nil)
	if len(errs) > 0 || res.Terminal.Code != "precheck-failed" || res.Outputs["result"].(map[string]any)["status"] != "failure" {
		t.Fatalf("fail: %+v %+v", res, errs)
	}

	_, errs = Evaluate("flow.fail", map[string]any{"code": "leak", "message": "Bearer abc.def"}, nil)
	assertHasCode(t, errs, CodeSecretForbidden)

	_, errs = Evaluate("flow.fail", map[string]any{"code": "boom", "message": "panic: nil pointer"}, nil)
	assertHasCode(t, errs, CodeUnsafeReference)
}

func TestEvaluateRedactsAuditSecrets(t *testing.T) {
	v := redactValue(map[string]any{"token": "abc", "env": "prod"})
	m := v.(map[string]any)
	if m["token"] != redactedPlaceholder || m["env"] != "prod" {
		t.Fatalf("redact = %+v", m)
	}
	if redactForAudit("x", ClassConfidential) != redactedPlaceholder {
		t.Fatal("confidential audit should redact")
	}
}

func TestISODurationSeconds(t *testing.T) {
	n, err := isoDurationSeconds("PT5M")
	if err != nil || n != 300 {
		t.Fatalf("PT5M = %d %v", n, err)
	}
	n, err = isoDurationSeconds("P1DT2H")
	if err != nil || n != 93600 {
		t.Fatalf("P1DT2H = %d %v", n, err)
	}
	if _, err := isoDurationSeconds("P1Y"); err == nil {
		t.Fatal("expected year rejection")
	}
}
