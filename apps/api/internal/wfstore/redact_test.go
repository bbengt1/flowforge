package wfstore

import "testing"

func TestRedactValueStripsSecrets(t *testing.T) {
	in := map[string]any{
		"name":     "deploy",
		"token":    "super-secret-token",
		"nested":   map[string]any{"password": "hunter2", "env": "prod"},
		"auth":     "Bearer abc.def",
		"safeList": []any{"ok", "Bearer leaked"},
	}
	got, ok := RedactValue(in).(map[string]any)
	if !ok {
		t.Fatalf("type %T", RedactValue(in))
	}
	if got["name"] != "deploy" {
		t.Fatalf("name = %#v", got["name"])
	}
	if got["token"] != redactedMarker {
		t.Fatalf("token = %#v", got["token"])
	}
	nested, _ := got["nested"].(map[string]any)
	if nested["password"] != redactedMarker || nested["env"] != "prod" {
		t.Fatalf("nested = %#v", nested)
	}
	if got["auth"] != redactedMarker {
		t.Fatalf("auth = %#v", got["auth"])
	}
	list, _ := got["safeList"].([]any)
	if len(list) != 2 || list[0] != "ok" || list[1] != redactedMarker {
		t.Fatalf("list = %#v", list)
	}
}

func TestFingerprintStableAndSensitiveToInput(t *testing.T) {
	a, err := fingerprintIdempotency("ws", "ver", "actor", "", map[string]any{"b": 1, "a": 2})
	if err != nil {
		t.Fatal(err)
	}
	b, err := fingerprintIdempotency("ws", "ver", "actor", "", map[string]any{"a": 2, "b": 1})
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("canonical order drifted: %s vs %s", a, b)
	}
	c, err := fingerprintIdempotency("ws", "ver", "actor", "", map[string]any{"a": 3, "b": 1})
	if err != nil {
		t.Fatal(err)
	}
	if a == c {
		t.Fatal("different input produced the same fingerprint")
	}
}

func TestValidateIdempotencyKey(t *testing.T) {
	if err := validateIdempotencyKey(""); err != nil {
		t.Fatal(err)
	}
	if err := validateIdempotencyKey("run-1"); err != nil {
		t.Fatal(err)
	}
	if err := validateIdempotencyKey("bad key"); err != ErrIdempotencyKeyInvalid {
		t.Fatalf("got %v", err)
	}
}
