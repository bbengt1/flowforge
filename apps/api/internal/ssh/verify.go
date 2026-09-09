package ssh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

// NormalizeVerification canonicalizes a command-profile verification object.
// retrySafe=true requires this probe. The template is reviewed the same way
// as the mutating command: {name} placeholders, POSIX quoting, no interpolation.
func NormalizeVerification(raw map[string]any, schema *ParameterSchema) (map[string]any, error) {
	if raw == nil {
		return nil, wrapInvalid("verification is required when retrySafe is true")
	}
	tmpl, _ := raw["template"].(string)
	canon, err := NormalizeTemplate(tmpl, schema)
	if err != nil {
		return nil, wrapInvalid("verification.template: %s", strings.TrimPrefix(err.Error(), ErrInvalid.Error()+": "))
	}
	expect := 0
	if _, exists := raw["expectExitCode"]; exists {
		n, err := asInt(raw["expectExitCode"])
		if err != nil || n < 0 || n > 255 {
			return nil, wrapInvalid("verification.expectExitCode must be an integer 0-255")
		}
		expect = n
	}
	contains := ""
	if raw["expectStdoutContains"] != nil {
		s, ok := raw["expectStdoutContains"].(string)
		if !ok {
			return nil, wrapInvalid("verification.expectStdoutContains must be a string")
		}
		contains = s
		if len(contains) > 256 {
			return nil, wrapInvalid("verification.expectStdoutContains length is invalid")
		}
	}
	onMatch := optionalOutcome(raw, "onMatch", VerifyAlreadyApplied)
	if onMatch != VerifyAlreadyApplied && onMatch != VerifySafeToRetry {
		return nil, wrapInvalid("verification.onMatch must be already-applied or safe-to-retry")
	}
	onMismatch := optionalOutcome(raw, "onMismatch", VerifySafeToRetry)
	if onMismatch != VerifyAlreadyApplied && onMismatch != VerifySafeToRetry && onMismatch != VerifyIndeterminate {
		return nil, wrapInvalid("verification.onMismatch must be already-applied, safe-to-retry, or indeterminate")
	}
	onError := optionalOutcome(raw, "onError", VerifyIndeterminate)
	if onError != VerifyIndeterminate {
		return nil, wrapInvalid("verification.onError must be indeterminate")
	}
	if err := rejectVerificationUnknown(raw); err != nil {
		return nil, err
	}
	out := map[string]any{
		"template":       canon,
		"expectExitCode": expect,
		"onMatch":        onMatch,
		"onMismatch":     onMismatch,
		"onError":        onError,
	}
	if contains != "" {
		out["expectStdoutContains"] = contains
	}
	return out, nil
}

// ParseVerification builds a typed spec from a normalized verification map.
func ParseVerification(raw map[string]any) (VerificationSpec, error) {
	if raw == nil {
		return VerificationSpec{}, wrapInvalid("verification is required")
	}
	tmpl, _ := raw["template"].(string)
	if strings.TrimSpace(tmpl) == "" {
		return VerificationSpec{}, wrapInvalid("verification.template is required")
	}
	expect := 0
	if raw["expectExitCode"] != nil {
		n, err := asInt(raw["expectExitCode"])
		if err != nil {
			return VerificationSpec{}, wrapInvalid("verification.expectExitCode must be an integer")
		}
		expect = n
	}
	contains, _ := raw["expectStdoutContains"].(string)
	spec := VerificationSpec{
		Template:             tmpl,
		ExpectExitCode:       expect,
		ExpectStdoutContains: contains,
		OnMatch:              optionalOutcome(raw, "onMatch", VerifyAlreadyApplied),
		OnMismatch:           optionalOutcome(raw, "onMismatch", VerifySafeToRetry),
		OnError:              optionalOutcome(raw, "onError", VerifyIndeterminate),
	}
	return spec, nil
}

// VerificationFromProfile returns the typed probe, or nil when the profile is not retry-safe.
func VerificationFromProfile(profile ProfileContext) (*VerificationSpec, *EngineError) {
	raw := verificationMap(profile)
	if !profile.RetrySafe {
		if raw != nil {
			return nil, engineError(CodeInvalidVerification, "verification is only valid when retrySafe is true", http.StatusBadRequest)
		}
		return nil, nil
	}
	if raw == nil {
		return nil, engineError(CodeInvalidVerification, "retrySafe profiles must declare verification.template", http.StatusBadRequest)
	}
	spec, err := ParseVerification(raw)
	if err != nil {
		return nil, engineError(CodeInvalidVerification, "command profile verification is invalid", http.StatusBadRequest)
	}
	return &spec, nil
}

// RenderVerificationFromSpec renders the probe using the same schema as the mutating command.
func RenderVerificationFromSpec(spec map[string]any, values map[string]any) (RenderResult, error) {
	if spec == nil {
		return RenderResult{}, wrapInvalid("spec is required")
	}
	verify, _ := spec["verification"].(map[string]any)
	if verify == nil {
		return RenderResult{}, wrapInvalid("verification is required")
	}
	schemaRaw, _ := spec["parameterSchema"].(map[string]any)
	schema, err := ParseSchema(schemaRaw)
	if err != nil {
		return RenderResult{}, err
	}
	tmpl, _ := verify["template"].(string)
	return Render(tmpl, schema, values)
}

func verificationMap(profile ProfileContext) map[string]any {
	if profile.Spec != nil {
		if raw, ok := profile.Spec["verification"].(map[string]any); ok {
			return raw
		}
	}
	return nil
}

func optionalOutcome(raw map[string]any, key, fallback string) string {
	if raw == nil {
		return fallback
	}
	v, ok := raw[key]
	if !ok || v == nil {
		return fallback
	}
	s, ok := v.(string)
	if !ok {
		return fallback
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return fallback
	}
	return s
}

func rejectVerificationUnknown(raw map[string]any) error {
	allowed := map[string]struct{}{
		"template":             {},
		"expectExitCode":       {},
		"expectStdoutContains": {},
		"onMatch":              {},
		"onMismatch":           {},
		"onError":              {},
	}
	for key := range raw {
		if _, ok := allowed[key]; !ok {
			return wrapInvalid("unknown verification field %s", key)
		}
	}
	return nil
}

func runVerification(ctx context.Context, sess Session, req Request, spec VerificationSpec) VerificationResult {
	out := VerificationResult{Ran: true, Outcome: spec.OnError, Note: "verification probe failed; outcome stays indeterminate"}
	var rendered RenderResult
	var err error
	if req.Profile.Spec != nil {
		rendered, err = RenderVerificationFromSpec(req.Profile.Spec, req.Parameters)
	} else {
		schema := req.Profile.Schema
		if schema == nil && req.Profile.Spec != nil {
			raw, _ := req.Profile.Spec["parameterSchema"].(map[string]any)
			schema, err = ParseSchema(raw)
		}
		if err == nil {
			rendered, err = Render(spec.Template, schema, req.Parameters)
		}
	}
	if err != nil {
		out.Note = "verification template could not be rendered"
		return out
	}
	sum := sha256.Sum256([]byte(rendered.Command))
	out.CommandDigest = "sha256:" + hex.EncodeToString(sum[:])
	stdout, _, exit, runErr := sess.Run(ctx, rendered.Command)
	if runErr != nil {
		out.Outcome = spec.OnError
		if spec.OnError == "" {
			out.Outcome = VerifyIndeterminate
		}
		out.Note = "verification probe did not return a reliable exit; command is not retried"
		return out
	}
	code := exit
	out.ExitCode = &code
	stdout = redactText(stdout)
	matched := exit == spec.ExpectExitCode
	if spec.ExpectStdoutContains != "" && !strings.Contains(stdout, spec.ExpectStdoutContains) {
		matched = false
	}
	out.Matched = matched
	if matched {
		out.Outcome = spec.OnMatch
		if out.Outcome == VerifyAlreadyApplied {
			out.Note = "verification matched: remote state already applied; mutating command is not re-run"
		} else {
			out.Note = "verification matched: safe to retry the mutating command"
		}
		return out
	}
	out.Outcome = spec.OnMismatch
	switch out.Outcome {
	case VerifyAlreadyApplied:
		out.Note = "verification mismatch interpreted as already-applied; mutating command is not re-run"
	case VerifySafeToRetry:
		out.Note = "verification mismatch: remote state is not applied; another attempt is allowed"
	default:
		out.Outcome = VerifyIndeterminate
		out.Note = "verification mismatch is inconclusive; outcome stays indeterminate"
	}
	return out
}

func leaseLossResult(req Request, out Result) Result {
	out.Error = engineError(CodeIndeterminate, "lease was lost after dispatch or the provider outcome is unknown; the command is not retried until verification confirms state", http.StatusConflict)
	out.OK = false
	out.Retry.Allowed = false
	if req.Profile.RetrySafe {
		verify, err := VerificationFromProfile(req.Profile)
		if err == nil && verify != nil && req.RetryPolicy.MaxAttempts > 0 {
			dec := EvaluateRetry(RetryEval{
				Status:             "indeterminate",
				Attempt:            requestAttempt(req),
				MaxAttempts:        req.RetryPolicy.MaxAttempts,
				RetrySafe:          true,
				HasVerification:    true,
				PriorIndeterminate: true,
			})
			out.Retry.Allowed = dec.Allowed
			out.Retry.RequiresVerification = true
			out.Retry.VerificationDeclared = true
			out.Retry.Note = "Indeterminate after lease loss. A later attempt may run the verification probe only — never a blind re-run."
			if !dec.Allowed {
				out.Retry.Note = dec.Reason
			}
		} else {
			out.Retry.Note = "Lease loss is indeterminate. retrySafe without remaining attempts or verification cannot retry."
		}
	} else {
		out.Retry.Note = "Lease loss is indeterminate. This profile is not retrySafe; retry stays disabled."
	}
	return finish(req, out)
}
