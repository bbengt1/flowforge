package ssh

import (
	"context"
	"strings"
	"testing"
)

func retrySafeSpec() map[string]any {
	return map[string]any{
		"parameterSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"unit": map[string]any{"type": "string", "minLength": 1, "maxLength": 64},
			},
			"required": []any{"unit"},
		},
		"template":  "touch /tmp/{unit}",
		"retrySafe": true,
		"verification": map[string]any{
			"template":       "test -f /tmp/{unit}",
			"expectExitCode": 0,
			"onMatch":        VerifyAlreadyApplied,
			"onMismatch":     VerifySafeToRetry,
		},
	}
}

func TestDefaultZeroRetries(t *testing.T) {
	if DefaultMaxAttempts != 0 {
		t.Fatalf("default maxAttempts = %d", DefaultMaxAttempts)
	}
	if MaxAttemptsFromWith(nil) != 0 || MaxAttemptsFromWith(map[string]any{}) != 0 {
		t.Fatal("omitted retryPolicy must default to 0")
	}
	if MaxAttemptsFromWith(map[string]any{"retryPolicy": map[string]any{}}) != 0 {
		t.Fatal("omitted maxAttempts must default to 0")
	}
	dec := EvaluateRetry(RetryEval{Status: "failed", Attempt: 1, MaxAttempts: 0, RetrySafe: true, HasVerification: true})
	if dec.Allowed || dec.Code != CodeRetryDenied {
		t.Fatalf("zero retries must deny: %+v", dec)
	}
}

func TestEvaluateRetryDeniedWithoutRetrySafe(t *testing.T) {
	dec := EvaluateRetry(RetryEval{Status: "failed", Attempt: 1, MaxAttempts: 2, RetrySafe: false, HasVerification: false})
	if dec.Allowed || dec.Code != CodeRetryDenied {
		t.Fatalf("maxAttempts without retrySafe: %+v", dec)
	}
	dec = EvaluateRetry(RetryEval{Status: "failed", Attempt: 1, MaxAttempts: 2, RetrySafe: true, HasVerification: false})
	if dec.Allowed || dec.Code != CodeRetryDenied {
		t.Fatalf("retrySafe without verification: %+v", dec)
	}
}

func TestRetrySafePathWithVerification(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	applied := false
	mutations := 0
	server.OnExec = func(cmd string) (string, uint32) {
		switch {
		case strings.HasPrefix(cmd, "test -f "):
			if applied {
				return "", 0
			}
			return "", 1
		case strings.HasPrefix(cmd, "touch "):
			mutations++
			if mutations == 1 {
				return "failed-first", 1
			}
			applied = true
			return "ok", 0
		default:
			return "unexpected", 2
		}
	}

	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.Profile = ProfileContextFromSpec("44444444-4444-4444-8444-444444444444", retrySafeSpec())
	req.RetryPolicy.MaxAttempts = 2
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("retrySafe verify+retry: %+v", res.Error)
	}
	if res.Retry.ExecutedAttempts != 2 {
		t.Fatalf("executed mutations = %d want 2; commands=%#v", res.Retry.ExecutedAttempts, server.Commands())
	}
	if res.Retry.Verification == nil || res.Retry.Verification.Outcome != VerifySafeToRetry {
		t.Fatalf("verification = %+v", res.Retry.Verification)
	}
	cmds := server.Commands()
	sawProbe := false
	touch := 0
	for _, c := range cmds {
		if strings.HasPrefix(c, "test -f ") {
			sawProbe = true
		}
		if strings.HasPrefix(c, "touch ") {
			touch++
		}
	}
	if !sawProbe || touch != 2 {
		t.Fatalf("commands = %#v", cmds)
	}
}

func TestRetrySafeAlreadyAppliedDoesNotRerun(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.OnExec = func(cmd string) (string, uint32) {
		if strings.HasPrefix(cmd, "test -f ") {
			return "", 0
		}
		return "should-not-run", 0
	}
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.Profile = ProfileContextFromSpec("p", retrySafeSpec())
	req.RetryPolicy.MaxAttempts = 2
	req.Attempt = 2
	req.PriorIndeterminate = true
	res := Execute(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("already-applied: %+v", res.Error)
	}
	if res.Retry.ExecutedAttempts != 0 {
		t.Fatalf("blind re-run after verify: attempts=%d cmds=%#v", res.Retry.ExecutedAttempts, server.Commands())
	}
	if res.Retry.Verification == nil || res.Retry.Verification.Outcome != VerifyAlreadyApplied {
		t.Fatalf("verification = %+v", res.Retry.Verification)
	}
	for _, c := range server.Commands() {
		if strings.HasPrefix(c, "touch ") {
			t.Fatalf("mutating command ran: %#v", server.Commands())
		}
	}
}

func TestNonRetrySafeLeaseLossStaysIndeterminate(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.LeaseLost = true
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeIndeterminate {
		t.Fatalf("lease: %+v", res.Error)
	}
	if res.Retry.Allowed {
		t.Fatal("non-retrySafe lease loss must not enable retry")
	}
	if len(server.Commands()) != 0 {
		t.Fatalf("retried after lease loss: %#v", server.Commands())
	}
	if res.Audit["outcome"] != "indeterminate" {
		t.Fatalf("audit outcome = %+v", res.Audit)
	}
}

func TestMaxAttemptsWithoutRetrySafeDenied(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.RetryPolicy.MaxAttempts = 3
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeRetryDenied {
		t.Fatalf("denied: %+v", res.Error)
	}
	if len(server.Commands()) != 0 {
		t.Fatal("command ran after retry-denied")
	}
}

func TestUnknownOutcomeAfterDispatchIsIndeterminate(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.UnknownOutcome = true
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeIndeterminate {
		t.Fatalf("unknown: %+v", res.Error)
	}
	if len(server.Commands()) != 0 {
		t.Fatal("unknown outcome must not start a command")
	}
}

func TestLeaseLossRetrySafeAllowsLaterVerifiedAttempt(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.Profile = ProfileContextFromSpec("p", retrySafeSpec())
	req.RetryPolicy.MaxAttempts = 1
	req.LeaseLost = true
	res := Execute(context.Background(), req)
	if res.Error == nil || res.Error.Code != CodeIndeterminate {
		t.Fatalf("lease: %+v", res.Error)
	}
	if !res.Retry.Allowed || !res.Retry.RequiresVerification {
		t.Fatalf("retry flag = %+v", res.Retry)
	}
	if len(server.Commands()) != 0 {
		t.Fatal("lease-loss call must not connect")
	}

	server.ResetRecords()
	server.OnExec = func(cmd string) (string, uint32) {
		if strings.HasPrefix(cmd, "test -f ") {
			return "", 1
		}
		return "ok", 0
	}
	req.LeaseLost = false
	req.PriorIndeterminate = true
	req.Attempt = 2
	res = Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("verified retry: %+v", res.Error)
	}
	if res.Retry.ExecutedAttempts != 1 {
		t.Fatalf("mutations = %d cmds=%#v", res.Retry.ExecutedAttempts, server.Commands())
	}
}

func TestNormalizeVerificationRequiresTemplate(t *testing.T) {
	_, schema, err := NormalizeParameterSchema(map[string]any{
		"type":       "object",
		"properties": map[string]any{"unit": map[string]any{"type": "string"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NormalizeVerification(nil, schema); err == nil {
		t.Fatal("nil verification")
	}
	if _, err := NormalizeVerification(map[string]any{"template": "echo $(whoami)"}, schema); err == nil {
		t.Fatal("interpolation")
	}
	out, err := NormalizeVerification(map[string]any{"template": "test -f /tmp/{unit}"}, schema)
	if err != nil {
		t.Fatal(err)
	}
	if out["onMatch"] != VerifyAlreadyApplied || out["onMismatch"] != VerifySafeToRetry || out["onError"] != VerifyIndeterminate {
		t.Fatalf("defaults = %+v", out)
	}
}
