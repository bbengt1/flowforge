package scripts

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestEvaluateRetryDeniedWithoutVerification(t *testing.T) {
	dec := EvaluateRetry(RetryEval{Status: "failed", Attempt: 1, MaxAttempts: 2, RetrySafe: true, HasVerification: false, HasIdempotencyKey: true})
	if dec.Allowed || dec.Code != CodeRetryDenied {
		t.Fatalf("missing verification: %+v", dec)
	}
	dec = EvaluateRetry(RetryEval{Status: "failed", Attempt: 1, MaxAttempts: 2, RetrySafe: true, HasVerification: true, HasIdempotencyKey: false})
	if dec.Allowed || dec.Code != CodeRetryDenied {
		t.Fatalf("missing idempotency key: %+v", dec)
	}
	dec = EvaluateRetry(RetryEval{Status: "failed", Attempt: 1, MaxAttempts: 0, RetrySafe: false})
	if dec.Allowed || dec.Code != CodeRetryDenied {
		t.Fatalf("default zero: %+v", dec)
	}
}

func TestEvaluateRetryAllowedWithGates(t *testing.T) {
	dec := EvaluateRetry(RetryEval{
		Status: "failed", Attempt: 1, MaxAttempts: 2,
		RetrySafe: true, HasVerification: true, HasIdempotencyKey: true,
	})
	if !dec.Allowed {
		t.Fatalf("expected allow: %+v", dec)
	}
}

func TestHandleScopingAndRedaction(t *testing.T) {
	h, err := NewHandle("h-1", "cred-1", "ws-1", []string{"credential.use"}, time.Now().UTC().Add(30*time.Second), []byte("-----BEGIN PRIVATE KEY-----\nMII\n"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "BEGIN PRIVATE") || strings.Contains(string(raw), "secret") {
		t.Fatalf("handle leaked secret: %s", raw)
	}
	if !strings.Contains(string(raw), `"id":"h-1"`) {
		t.Fatalf("public handle = %s", raw)
	}
	pubs, err := PublicHandles([]Handle{*h}, time.Time{})
	if err != nil || len(pubs) != 1 {
		t.Fatalf("public = %v %v", pubs, err)
	}
	if _, err := NewHandle("", "c", "w", []string{"credential.use"}, time.Now().Add(time.Minute), nil); err == nil {
		t.Fatal("empty id must fail")
	}
	if _, err := NewHandle("h-2", "c", "w", nil, time.Now().Add(time.Minute), nil); err == nil {
		t.Fatal("unscoped handle must fail")
	}
	expired, err := NewHandle("h-3", "c", "w", []string{"credential.use"}, time.Now().UTC().Add(time.Second), nil)
	if err != nil {
		t.Fatal(err)
	}
	expired.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	if _, err := PublicHandles([]Handle{*expired}, time.Now().UTC()); err == nil {
		t.Fatal("expired handle must fail")
	}
}

func TestExecuteTypedIOAndRecovery(t *testing.T) {
	art, key, profile := publishedPython(t)
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"name"},
		"properties":           map[string]any{"name": map[string]any{"type": "string"}},
	}
	base := Request{
		Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
		Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile, Permissions: operatorPerms(),
		InputSchema: schema, OutputSchema: map[string]any{"type": "object"},
	}

	t.Run("schema rejection before inject", func(t *testing.T) {
		req := base
		req.Input = map[string]any{"nope": true}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeInvalidSchema {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("size rejection before inject", func(t *testing.T) {
		req := base
		req.Input = map[string]any{"name": strings.Repeat("n", MaxInputBytes)}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || (out.Error.Code != CodeSizeLimit && out.Error.Code != CodeInputRejected) {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("handle scoping and env allowlist", func(t *testing.T) {
		h, err := NewHandle("handle-1", "cred-1", "ws-1", []string{"credential.use"}, time.Now().UTC().Add(45*time.Second), []byte("super-secret-value"))
		if err != nil {
			t.Fatal(err)
		}
		req := base
		req.Input = map[string]any{"name": "ok"}
		req.Handles = []Handle{*h}
		req.CorrelationID = "corr-io"
		out := Execute(context.Background(), req)
		if !out.OK || out.Error != nil {
			t.Fatalf("%+v", out)
		}
		if !out.InputValidated || !out.OutputValidated {
			t.Fatalf("validation flags = %+v", out)
		}
		raw, _ := json.Marshal(out)
		if strings.Contains(string(raw), "super-secret-value") {
			t.Fatalf("result leaked handle secret: %s", raw)
		}
		if len(out.Handles) != 1 || out.Handles[0]["id"] != "handle-1" {
			t.Fatalf("handles = %+v", out.Handles)
		}
		if out.Env["FLOWFORGE_HANDLE_IDS"] != "handle-1" || out.Env["FLOWFORGE_CORRELATION_ID"] != "corr-io" {
			t.Fatalf("env = %+v", out.Env)
		}
	})
	t.Run("plaintext env denied", func(t *testing.T) {
		req := base
		req.Input = map[string]any{"name": "ok"}
		req.ExtraEnv = map[string]string{"AWS_SECRET_ACCESS_KEY": "abc"}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeEnvDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("output oversize", func(t *testing.T) {
		req := base
		req.Input = map[string]any{"name": "ok"}
		req.Runtime = oversizeRuntime{}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeOutputTooLarge {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("lease loss is indeterminate and not retried", func(t *testing.T) {
		req := base
		req.Input = map[string]any{"name": "ok"}
		req.LeaseLost = true
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeIndeterminate {
			t.Fatalf("%+v", out)
		}
		if out.Retry.Allowed {
			t.Fatal("non-retrySafe lease loss must not enable retry")
		}
	})
	t.Run("retry denied without verification", func(t *testing.T) {
		req := base
		req.Input = map[string]any{"name": "ok"}
		req.RetrySafe = true
		req.IdempotencyKey = "summarize-once"
		req.RetryPolicy = RetryPolicy{MaxAttempts: 2}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || (out.Error.Code != CodeRetryDenied && out.Error.Code != CodeInvalidVerification) {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("retry-safe verify-first never blind re-runs", func(t *testing.T) {
		req := base
		req.Input = map[string]any{"name": "ok"}
		req.RetrySafe = true
		req.IdempotencyKey = "summarize-once"
		req.RetryPolicy = RetryPolicy{MaxAttempts: 2}
		req.Verification = &VerificationSpec{
			Behavior: VerificationBehaviorHook, OnMatch: VerifyAlreadyApplied,
			OnMismatch: VerifySafeToRetry, OnError: VerifyIndeterminate,
			Expect: map[string]any{"status": "ok"},
		}
		req.Attempt = 2
		req.PriorIndeterminate = true
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeIndeterminate {
			t.Fatalf("indet without prior output: %+v", out)
		}
		req.PriorIndeterminate = false
		req.PriorOutput = nil
		req.Verification.Expect = nil
		ran := false
		req.Runtime = runProbeRuntime{ran: &ran}
		out = Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeIndeterminate || ran {
			t.Fatalf("empty prior output must stay indeterminate: %+v ran=%v", out, ran)
		}
		req.Runtime = nil
		req.Verification.Expect = map[string]any{"status": "ok"}
		req.PriorOutput = map[string]any{"status": "ok"}
		out = Execute(context.Background(), req)
		if !out.OK || out.Error != nil || out.Retry.Verification == nil || out.Retry.Verification.Outcome != VerifyAlreadyApplied {
			t.Fatalf("already-applied: %+v", out)
		}
	})
}

func TestParseVerificationRequiresExplicitBehavior(t *testing.T) {
	if _, err := ParseVerification(map[string]any{}); err == nil {
		t.Fatal("empty verification must fail")
	}
	if _, err := ParseVerification(map[string]any{"behavior": true}); err == nil {
		t.Fatal("non-string behavior must fail")
	}
	if _, err := ParseVerification(map[string]any{"behavior": ""}); err == nil {
		t.Fatal("empty behavior must fail")
	}
	spec, err := ParseVerification(map[string]any{"behavior": VerificationBehaviorHook})
	if err != nil || spec.Behavior != VerificationBehaviorHook {
		t.Fatalf("explicit hook: %v %+v", err, spec)
	}
}

func TestOutputSchemaPreservesObjectShape(t *testing.T) {
	if err := RequireObjectRoot(map[string]any{"type": "array"}, "outputSchema"); err == nil {
		t.Fatal("array root must fail")
	}
	if err := RequireObjectRoot(map[string]any{"type": "string"}, "outputSchema"); err == nil {
		t.Fatal("string root must fail")
	}
	obj, _, err := ValidateExecutionOutput(`{"status":"ok"}`, map[string]any{"type": "object"})
	if err != nil || obj["status"] != "ok" || obj["value"] != nil {
		t.Fatalf("object output: %v %+v", err, obj)
	}
	if _, _, err := ValidateExecutionOutput(`["a"]`, map[string]any{"type": "object"}); err == nil {
		t.Fatal("array output against object schema must fail")
	}
	if _, _, err := ValidateExecutionOutput(`["a"]`, map[string]any{"type": "array"}); err == nil {
		t.Fatal("array root schema must fail closed instead of wrapping as {value:...}")
	}
	if _, _, err := ValidateExecutionOutput(`"ok"`, map[string]any{"type": "string"}); err == nil {
		t.Fatal("string root schema must fail closed instead of wrapping as {value:...}")
	}
}

type runProbeRuntime struct{ ran *bool }

func (runProbeRuntime) Name() string { return IsolationModeHarness }

func (r runProbeRuntime) Run(ctx context.Context, spec IsolationSpec, job IsolatedJob) (IsolatedResult, error) {
	if r.ran != nil {
		*r.ran = true
	}
	return HarnessRuntime{}.Run(ctx, spec, job)
}

type oversizeRuntime struct{}

func (oversizeRuntime) Name() string { return IsolationModeHarness }

func (oversizeRuntime) Run(ctx context.Context, spec IsolationSpec, job IsolatedJob) (IsolatedResult, error) {
	if err := ValidateIsolation(spec); err != nil {
		return IsolatedResult{}, err
	}
	return IsolatedResult{OK: true, ExitCode: 0, Stdout: `{"blob":"` + strings.Repeat("o", MaxOutputBytes) + `"}`}, nil
}
