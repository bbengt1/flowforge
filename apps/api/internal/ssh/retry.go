package ssh

import (
	"net/http"
	"strings"
)

// Verification outcomes. These are the only legal results of a profile probe.
const (
	VerifyAlreadyApplied = "already-applied"
	VerifySafeToRetry    = "safe-to-retry"
	VerifyIndeterminate  = "indeterminate"
)

// Retry semantics documented for Chloe and persisted on engine results.
const (
	RetrySemantics            = "E8.3"
	RetryVerificationContract = "profile-declared-idempotent-probe"
)

// VerificationSpec is the idempotent probe required when retrySafe=true.
// It uses the same parameterSchema and reviewed renderer as the mutating template.
type VerificationSpec struct {
	Template             string `json:"template"`
	ExpectExitCode       int    `json:"expectExitCode"`
	ExpectStdoutContains string `json:"expectStdoutContains,omitempty"`
	OnMatch              string `json:"onMatch"`
	OnMismatch           string `json:"onMismatch"`
	OnError              string `json:"onError"`
}

// VerificationResult is the secret-free probe outcome (no command text).
type VerificationResult struct {
	Ran           bool   `json:"ran"`
	Outcome       string `json:"outcome"`
	Matched       bool   `json:"matched,omitempty"`
	ExitCode      *int   `json:"exitCode,omitempty"`
	CommandDigest string `json:"commandDigest,omitempty"`
	Note          string `json:"note,omitempty"`
}

// RetryState is persisted on ssh.run results for Chloe and the retry APIs.
type RetryState struct {
	MaxAttempts            int                 `json:"maxAttempts"`
	ExecutedAttempts       int                 `json:"executedAttempts"`
	RetrySafe              bool                `json:"retrySafe"`
	Allowed                bool                `json:"allowed"`
	RequiresVerification   bool                `json:"requiresVerification"`
	VerificationDeclared   bool                `json:"verificationDeclared"`
	Semantics              string              `json:"semantics"`
	Note                   string              `json:"note"`
	Verification           *VerificationResult `json:"verification,omitempty"`
}

// RetryEval is the control-plane / engine input for EvaluateRetry.
type RetryEval struct {
	Status             string
	Attempt            int
	MaxAttempts        int
	RetrySafe          bool
	HasVerification    bool
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
	n, err := asInt(v)
	if err != nil {
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
// Retries default to zero. A retry is allowed only when the pinned profile is
// retrySafe, declares verification, maxAttempts > 0, attempts remain, and the
// prior status is failed, canceled, or indeterminate. Indeterminate without
// those flags stays non-retryable.
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
	if !in.RetrySafe || !in.HasVerification {
		return RetryDecision{
			Allowed:              false,
			Code:                 CodeRetryDenied,
			Reason:               "retry requires a retrySafe profile with an idempotent verification probe",
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

func normalizeRetry(req Request) (RetryState, *EngineError) {
	policy, err := NormalizeRetryPolicy(req.RetryPolicy)
	if err != nil {
		return RetryState{}, err
	}
	safe := req.Profile.RetrySafe
	verify, verr := VerificationFromProfile(req.Profile)
	if verr != nil {
		return RetryState{}, verr
	}
	hasVerify := verify != nil
	if policy.MaxAttempts > 0 && !safe {
		return RetryState{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts>0 requires a retrySafe command profile with verification", http.StatusBadRequest)
	}
	if policy.MaxAttempts > 0 && !hasVerify {
		return RetryState{}, engineError(CodeRetryDenied, "retryPolicy.maxAttempts>0 requires a profile-declared verification probe", http.StatusBadRequest)
	}
	if safe && !hasVerify {
		return RetryState{}, engineError(CodeInvalidVerification, "retrySafe profiles must declare an idempotent verification probe", http.StatusBadRequest)
	}
	note := "Retries default to zero. The mutating command is never blindly re-run."
	allowed := false
	if safe && hasVerify && policy.MaxAttempts > 0 {
		note = "Retry is allowed only after the profile verification probe confirms remote state."
		dec := EvaluateRetry(RetryEval{
			Status:             retryStatusForRequest(req),
			Attempt:            requestAttempt(req),
			MaxAttempts:        policy.MaxAttempts,
			RetrySafe:          true,
			HasVerification:    true,
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
		Semantics:            RetrySemantics,
		Note:                 note,
	}, nil
}

func retryStatusForRequest(req Request) string {
	if req.LeaseLost || req.UnknownOutcome || req.PriorIndeterminate {
		return "indeterminate"
	}
	if requestAttempt(req) > 1 {
		return "failed"
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
			RetrySafe:   req.Profile.RetrySafe,
			Semantics:   RetrySemantics,
			Note:        err.Error(),
		}
	}
	return state
}
