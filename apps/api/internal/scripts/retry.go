package scripts

import (
	"net/http"
	"regexp"
	"strings"
)

var idempotencyKeyRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._:-]{0,127}$`)

// RetryPolicy is the explicit node field. Default maxAttempts is 0.
type RetryPolicy struct {
	MaxAttempts int `json:"maxAttempts"`
}

// VerificationSpec is the node-declared idempotent hook required when retrySafe.
type VerificationSpec struct {
	Behavior   string         `json:"behavior"`
	Expect     map[string]any `json:"expect,omitempty"`
	OnMatch    string         `json:"onMatch"`
	OnMismatch string         `json:"onMismatch"`
	OnError    string         `json:"onError"`
}

// VerificationResult is the secret-free probe outcome.
type VerificationResult struct {
	Ran     bool   `json:"ran"`
	Outcome string `json:"outcome"`
	Matched bool   `json:"matched,omitempty"`
	Note    string `json:"note,omitempty"`
}

// RetryState is persisted on script results for Chloe and the retry APIs.
type RetryState struct {
	MaxAttempts          int                 `json:"maxAttempts"`
	ExecutedAttempts     int                 `json:"executedAttempts"`
	RetrySafe            bool                `json:"retrySafe"`
	Allowed              bool                `json:"allowed"`
	RequiresVerification bool                `json:"requiresVerification"`
	VerificationDeclared bool                `json:"verificationDeclared"`
	IdempotencyKey       string              `json:"idempotencyKey,omitempty"`
	Semantics            string              `json:"semantics"`
	Note                 string              `json:"note"`
	Verification         *VerificationResult `json:"verification,omitempty"`
}

// RetryEval is the control-plane / engine input for EvaluateRetry.
type RetryEval struct {
	Status             string
	Attempt            int
	MaxAttempts        int
	RetrySafe          bool
	HasVerification    bool
	HasIdempotencyKey  bool
	PriorIndeterminate bool
}

// RetryDecision is the fail-closed answer to "may another attempt be queued / run?"
type RetryDecision struct {
	Allowed              bool
	Code                 string
	Reason               string
	RetrySafe            bool
	RequiresVerification bool
}

// MaxAttemptsFromAny reads retryPolicy.maxAttempts. Omitted / invalid → default 0.
func MaxAttemptsFromAny(raw any) int {
	m, ok := raw.(map[string]any)
	if !ok || m == nil {
		return DefaultMaxAttempts
	}
	v, exists := m["maxAttempts"]
	if !exists || v == nil {
		return DefaultMaxAttempts
	}
	n, ok := asInt(v)
	if !ok {
		return DefaultMaxAttempts
	}
	return n
}

// MaxAttemptsFromWith reads node.with.retryPolicy.maxAttempts (default 0).
func MaxAttemptsFromWith(with map[string]any) int {
	if with == nil {
		return DefaultMaxAttempts
	}
	return MaxAttemptsFromAny(with["retryPolicy"])
}

// NormalizeRetryPolicy validates the explicit node field. Default is 0.
func NormalizeRetryPolicy(p RetryPolicy) (RetryPolicy, *EngineError) {
	if p.MaxAttempts < 0 || p.MaxAttempts > MaxRetryAttempts {
		return RetryPolicy{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts must be between 0 and 5", http.StatusBadRequest)
	}
	return RetryPolicy{MaxAttempts: p.MaxAttempts}, nil
}

// EvaluateRetry is the single rule used by Execute, catalogs, and step retry APIs.
// Retries default to zero. A retry is allowed only when the node is retrySafe,
// declares an idempotency key and verification behavior, maxAttempts > 0,
// attempts remain, and the prior status is failed, canceled, or indeterminate.
func EvaluateRetry(in RetryEval) RetryDecision {
	attempt := in.Attempt
	if attempt < 1 {
		attempt = 1
	}
	max := in.MaxAttempts
	if max < 0 {
		max = 0
	}
	needVerify := in.RetrySafe
	if !in.RetrySafe || !in.HasVerification || !in.HasIdempotencyKey {
		return RetryDecision{
			Allowed:              false,
			Code:                 CodeRetryDenied,
			Reason:               "retry requires retrySafe, a declared idempotency key, and verification behavior",
			RetrySafe:            in.RetrySafe,
			RequiresVerification: needVerify,
		}
	}
	if max <= 0 {
		return RetryDecision{
			Allowed:              false,
			Code:                 CodeRetryDenied,
			Reason:               "retryPolicy.maxAttempts defaults to 0; retries are disabled",
			RetrySafe:            true,
			RequiresVerification: true,
		}
	}
	if max > MaxRetryAttempts {
		return RetryDecision{
			Allowed:              false,
			Code:                 CodeRetryDenied,
			Reason:               "retryPolicy.maxAttempts must be between 0 and 5",
			RetrySafe:            true,
			RequiresVerification: true,
		}
	}
	if attempt >= 1+max {
		return RetryDecision{
			Allowed:              false,
			Code:                 CodeRetryDenied,
			Reason:               "no retry attempts remain",
			RetrySafe:            true,
			RequiresVerification: true,
		}
	}
	switch strings.TrimSpace(in.Status) {
	case "", "failed", "canceled", "indeterminate":
	default:
		return RetryDecision{
			Allowed:              false,
			Code:                 CodeRetryDenied,
			Reason:               "retry is not allowed from this step status",
			RetrySafe:            true,
			RequiresVerification: true,
		}
	}
	return RetryDecision{
		Allowed:              true,
		RetrySafe:            true,
		RequiresVerification: true,
	}
}

// ValidateRetryDeclaration checks node with.retrySafe / idempotencyKey / verification.
func ValidateRetryDeclaration(with map[string]any) error {
	decl, err := RetryDeclarationFromWith(with)
	if err != nil {
		return err
	}
	if decl.Policy.MaxAttempts > 0 && (!decl.RetrySafe || decl.Verification == nil || decl.IdempotencyKey == "") {
		return engineError(CodeRetryDenied, "retryPolicy.maxAttempts>0 requires retrySafe, an idempotency key, and verification", http.StatusBadRequest)
	}
	return nil
}

// RetryDeclaration is the node-level retry/idempotency contract.
type RetryDeclaration struct {
	RetrySafe      bool
	IdempotencyKey string
	Verification   *VerificationSpec
	Policy         RetryPolicy
}

// RetryDeclarationFromWith reads and validates retry fields from YAML `with`.
func RetryDeclarationFromWith(with map[string]any) (RetryDeclaration, error) {
	out := RetryDeclaration{}
	if with == nil {
		return out, nil
	}
	if raw, exists := with["retrySafe"]; exists {
		b, ok := raw.(bool)
		if !ok {
			return out, engineError(CodeInvalidVerification, "retrySafe must be a boolean.", http.StatusBadRequest)
		}
		out.RetrySafe = b
	}
	if raw, exists := with["idempotencyKey"]; exists && raw != nil {
		s, ok := raw.(string)
		if !ok {
			return out, engineError(CodeInvalidVerification, "idempotencyKey must be a string.", http.StatusBadRequest)
		}
		s = strings.TrimSpace(s)
		if s != "" && !idempotencyKeyRE.MatchString(s) {
			return out, engineError(CodeInvalidVerification, "idempotencyKey must be 1–128 letters, digits, or ._: - and start with a letter.", http.StatusBadRequest)
		}
		out.IdempotencyKey = s
	}
	if raw, exists := with["verification"]; exists && raw != nil {
		m, ok := raw.(map[string]any)
		if !ok {
			return out, engineError(CodeInvalidVerification, "verification must be an object.", http.StatusBadRequest)
		}
		spec, err := ParseVerification(m)
		if err != nil {
			return out, err
		}
		out.Verification = &spec
	}
	if raw, exists := with["retryPolicy"]; exists && raw != nil {
		m, ok := raw.(map[string]any)
		if !ok {
			return out, engineError(CodeRetryDenied, "retryPolicy must be an object.", http.StatusBadRequest)
		}
		policy, err := NormalizeRetryPolicy(RetryPolicy{MaxAttempts: MaxAttemptsFromAny(m)})
		if err != nil {
			return out, err
		}
		out.Policy = policy
	}
	if out.RetrySafe {
		if out.IdempotencyKey == "" {
			return out, engineError(CodeInvalidVerification, "retrySafe nodes must declare an idempotency key.", http.StatusBadRequest)
		}
		if out.Verification == nil {
			return out, engineError(CodeInvalidVerification, "retrySafe nodes must declare verification.behavior.", http.StatusBadRequest)
		}
	} else if out.Verification != nil || out.IdempotencyKey != "" {
		return out, engineError(CodeInvalidVerification, "idempotencyKey and verification are only valid when retrySafe is true.", http.StatusBadRequest)
	}
	return out, nil
}

// ParseVerification builds a typed spec from a node verification object.
func ParseVerification(raw map[string]any) (VerificationSpec, error) {
	if raw == nil {
		return VerificationSpec{}, engineError(CodeInvalidVerification, "verification is required.", http.StatusBadRequest)
	}
	for k := range raw {
		switch k {
		case "behavior", "expect", "onMatch", "onMismatch", "onError":
		default:
			return VerificationSpec{}, engineError(CodeInvalidVerification, "unknown verification field "+k+".", http.StatusBadRequest)
		}
	}
	rawBehavior, exists := raw["behavior"]
	if !exists || rawBehavior == nil {
		return VerificationSpec{}, engineError(CodeInvalidVerification, "verification.behavior must be declared-hook.", http.StatusBadRequest)
	}
	behavior, ok := rawBehavior.(string)
	if !ok {
		return VerificationSpec{}, engineError(CodeInvalidVerification, "verification.behavior must be declared-hook.", http.StatusBadRequest)
	}
	behavior = strings.TrimSpace(behavior)
	if behavior != VerificationBehaviorHook {
		return VerificationSpec{}, engineError(CodeInvalidVerification, "verification.behavior must be declared-hook.", http.StatusBadRequest)
	}
	var expect map[string]any
	if raw["expect"] != nil {
		m, ok := raw["expect"].(map[string]any)
		if !ok {
			return VerificationSpec{}, engineError(CodeInvalidVerification, "verification.expect must be an object.", http.StatusBadRequest)
		}
		if err := rejectPersistedSecrets(m, "verification.expect"); err != nil {
			return VerificationSpec{}, err
		}
		expect = m
	}
	onMatch := optionalOutcome(raw, "onMatch", VerifyAlreadyApplied)
	if onMatch != VerifyAlreadyApplied && onMatch != VerifySafeToRetry {
		return VerificationSpec{}, engineError(CodeInvalidVerification, "verification.onMatch must be already-applied or safe-to-retry.", http.StatusBadRequest)
	}
	onMismatch := optionalOutcome(raw, "onMismatch", VerifySafeToRetry)
	if onMismatch != VerifyAlreadyApplied && onMismatch != VerifySafeToRetry && onMismatch != VerifyIndeterminate {
		return VerificationSpec{}, engineError(CodeInvalidVerification, "verification.onMismatch must be already-applied, safe-to-retry, or indeterminate.", http.StatusBadRequest)
	}
	onError := optionalOutcome(raw, "onError", VerifyIndeterminate)
	if onError != VerifyIndeterminate {
		return VerificationSpec{}, engineError(CodeInvalidVerification, "verification.onError must be indeterminate.", http.StatusBadRequest)
	}
	return VerificationSpec{
		Behavior:   behavior,
		Expect:     expect,
		OnMatch:    onMatch,
		OnMismatch: onMismatch,
		OnError:    onError,
	}, nil
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

func normalizeRetry(req Request) (RetryState, *EngineError) {
	policy, err := NormalizeRetryPolicy(req.RetryPolicy)
	if err != nil {
		return RetryState{}, err
	}
	safe := req.RetrySafe
	hasVerify := req.Verification != nil
	hasKey := strings.TrimSpace(req.IdempotencyKey) != ""
	if policy.MaxAttempts > 0 && !safe {
		return RetryState{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts>0 requires retrySafe, an idempotency key, and verification", http.StatusBadRequest)
	}
	if policy.MaxAttempts > 0 && (!hasVerify || !hasKey) {
		return RetryState{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts>0 requires a declared idempotency key and verification behavior", http.StatusBadRequest)
	}
	if safe && !hasVerify {
		return RetryState{}, engineError(CodeInvalidVerification, "retrySafe nodes must declare verification.behavior", http.StatusBadRequest)
	}
	if safe && !hasKey {
		return RetryState{}, engineError(CodeInvalidVerification, "retrySafe nodes must declare an idempotency key", http.StatusBadRequest)
	}
	note := "Retries default to zero. The script is never blindly re-run."
	allowed := false
	if safe && hasVerify && hasKey && policy.MaxAttempts > 0 {
		note = "Retry is allowed only after the declared verification hook confirms state."
		dec := EvaluateRetry(RetryEval{
			Status:             retryStatusForRequest(req),
			Attempt:            requestAttempt(req),
			MaxAttempts:        policy.MaxAttempts,
			RetrySafe:          true,
			HasVerification:    true,
			HasIdempotencyKey:  true,
			PriorIndeterminate: req.PriorIndeterminate || req.LeaseLost || req.UnknownOutcome,
		})
		allowed = dec.Allowed
		if dec.Reason != "" && !dec.Allowed {
			note = dec.Reason
		}
	}
	return RetryState{
		MaxAttempts:          policy.MaxAttempts,
		ExecutedAttempts:     0,
		RetrySafe:            safe,
		Allowed:              allowed,
		RequiresVerification: safe,
		VerificationDeclared: hasVerify,
		IdempotencyKey:       strings.TrimSpace(req.IdempotencyKey),
		Semantics:            RetrySemantics,
		Note:                 note,
	}, nil
}

func retryStatusForRequest(req Request) string {
	if req.LeaseLost || req.UnknownOutcome || req.PriorIndeterminate {
		return "indeterminate"
	}
	return "failed"
}

func requestAttempt(req Request) int {
	if req.Attempt < 1 {
		return 1
	}
	return req.Attempt
}

func stubRetry(req Request) RetryState {
	state, err := normalizeRetry(req)
	if err != nil {
		return RetryState{
			MaxAttempts: req.RetryPolicy.MaxAttempts,
			RetrySafe:   req.RetrySafe,
			Semantics:   RetrySemantics,
			Note:        err.Error(),
		}
	}
	return state
}

func runVerification(req Request, spec VerificationSpec) VerificationResult {
	out := VerificationResult{Ran: true, Outcome: spec.OnError, Note: "verification hook failed; outcome stays indeterminate"}
	if spec.OnError == "" {
		out.Outcome = VerifyIndeterminate
	}
	if len(req.PriorOutput) == 0 {
		out.Outcome = VerifyIndeterminate
		out.Note = "verification has no prior output to confirm; the script is not re-run"
		return out
	}
	matched := outputMatchesExpect(req.PriorOutput, spec.Expect)
	out.Matched = matched
	if matched {
		out.Outcome = spec.OnMatch
		if out.Outcome == VerifyAlreadyApplied {
			out.Note = "verification matched: state already applied; the script is not re-run"
		} else {
			out.Note = "verification matched: safe to retry the script"
		}
		return out
	}
	out.Outcome = spec.OnMismatch
	switch out.Outcome {
	case VerifyAlreadyApplied:
		out.Note = "verification mismatch interpreted as already-applied; the script is not re-run"
	case VerifySafeToRetry:
		out.Note = "verification mismatch: state is not applied; another attempt is allowed"
	default:
		out.Outcome = VerifyIndeterminate
		out.Note = "verification mismatch is inconclusive; outcome stays indeterminate"
	}
	return out
}

func outputMatchesExpect(prior, expect map[string]any) bool {
	if len(expect) == 0 {
		if len(prior) == 0 {
			return false
		}
		if ok, _ := prior["ok"].(bool); ok {
			return true
		}
		if status, _ := prior["status"].(string); status == "ok" || status == "complete" || status == "already-applied" {
			return true
		}
		return false
	}
	for k, want := range expect {
		got, exists := prior[k]
		if !exists || !valuesEqual(got, want) {
			return false
		}
	}
	return true
}

func leaseLossResult(req Request, out Result) Result {
	out.Error = engineError(CodeIndeterminate, "Worker lease was lost or the provider outcome is unknown; the script is not retried until a verification hook resolves it.", http.StatusConflict)
	out.OK = false
	out.Retry.Allowed = false
	if req.RetrySafe && req.Verification != nil && strings.TrimSpace(req.IdempotencyKey) != "" && req.RetryPolicy.MaxAttempts > 0 {
		dec := EvaluateRetry(RetryEval{
			Status:             "indeterminate",
			Attempt:            requestAttempt(req),
			MaxAttempts:        req.RetryPolicy.MaxAttempts,
			RetrySafe:          true,
			HasVerification:    true,
			HasIdempotencyKey:  true,
			PriorIndeterminate: true,
		})
		out.Retry.Allowed = dec.Allowed
		out.Retry.RequiresVerification = true
		out.Retry.VerificationDeclared = true
		out.Retry.Note = "Indeterminate after lease loss. A later attempt may run the verification hook only — never a blind re-run."
		if !dec.Allowed {
			out.Retry.Note = dec.Reason
		}
	} else if req.RetrySafe {
		out.Retry.Note = "Lease loss is indeterminate. retrySafe without remaining attempts or verification cannot retry."
	} else {
		out.Retry.Note = "Lease loss is indeterminate. This node is not retrySafe; retry stays disabled."
	}
	return finish(req, out)
}
