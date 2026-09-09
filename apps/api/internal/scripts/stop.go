package scripts

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// EmergencyStopPolicy is the documented kind=script emergency-stop gate.
type EmergencyStopPolicy struct {
	Allow          bool   `json:"allow"`
	PolicyGated    bool   `json:"policyGated"`
	MissingIsAllow bool   `json:"missingPolicyAllows"`
	DeniedReason   string `json:"deniedReason,omitempty"`
}

// AuthorizeEmergencyStop requires script.emergencyStop and an allowing
// kind=script policy (missing policy allows, matching Evaluate).
func AuthorizeEmergencyStop(perms []string, policySpec map[string]any) error {
	if !authz.Allows(perms, authz.PermScriptEmergencyStop) {
		return engineError(CodePermissionDenied, "caller is not authorized for script emergency stop.", http.StatusForbidden)
	}
	return EvaluateEmergencyStopPolicy(policySpec)
}

// EvaluateEmergencyStopPolicy fails closed when a bound policy denies stop.
func EvaluateEmergencyStopPolicy(spec map[string]any) error {
	dec := DescribeEmergencyStopPolicy(spec)
	if dec.Allow {
		return nil
	}
	reason := dec.DeniedReason
	if reason == "" {
		reason = "policy denies emergency stop"
	}
	return engineError(CodePolicyDenied, reason, http.StatusForbidden)
}

// DescribeEmergencyStopPolicy documents the gate for catalog and tests.
func DescribeEmergencyStopPolicy(spec map[string]any) EmergencyStopPolicy {
	out := EmergencyStopPolicy{Allow: true, PolicyGated: true, MissingIsAllow: true}
	if spec == nil {
		return out
	}
	kind := strings.TrimSpace(stringField(spec, "kind"))
	rules, _ := spec["policy"].(map[string]any)
	if rules == nil {
		rules = spec
	}
	if kind != "" && kind != "script" && kind != "approval" {
		out.Allow = false
		out.DeniedReason = "policy kind does not match emergency stop"
		return out
	}
	if boolField(rules, "deny") {
		out.Allow = false
		out.DeniedReason = "policy denies this operation"
		return out
	}
	if v, ok := boolPresent(rules, "allowEmergencyStop"); ok && !v {
		out.Allow = false
		out.DeniedReason = "policy does not allow emergency stop"
		return out
	}
	if v, ok := boolPresent(rules, "emergencyStop"); ok && !v {
		out.Allow = false
		out.DeniedReason = "policy does not allow emergency stop"
		return out
	}
	return out
}

func boolPresent(m map[string]any, key string) (bool, bool) {
	if m == nil {
		return false, false
	}
	raw, ok := m[key]
	if !ok || raw == nil {
		return false, false
	}
	b, ok := raw.(bool)
	return b, ok
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return strings.TrimSpace(s)
}

func boolField(m map[string]any, key string) bool {
	v, ok := boolPresent(m, key)
	return ok && v
}

// EmergencyStopAudit is secret-free evidence for an authorized stop.
func EmergencyStopAudit(executionID, stepID, jobID, outcome, actorID string, uncertain bool) map[string]any {
	out := map[string]any{
		"action":    AuditEmergencyStop,
		"outcome":   outcome,
		"uncertain": uncertain,
	}
	if executionID != "" {
		out["executionId"] = executionID
	}
	if stepID != "" {
		out["stepId"] = stepID
	}
	if jobID != "" {
		out["jobId"] = jobID
	}
	if actorID != "" {
		out["actorId"] = actorID
	}
	return out
}

func emergencyStopResult(req Request, out Result, uncertain bool) Result {
	out.OK = false
	out.Retry.Allowed = false
	if uncertain {
		out.Error = engineError(CodeIndeterminate, "Emergency stop left the script outcome indeterminate until a verification hook resolves it.", http.StatusConflict)
		out.Retry.Note = "Emergency stop after dispatch is indeterminate. Never assume the script did not run."
	} else {
		out.Error = engineError(CodeEmergencyStopped, "Emergency stop halted the script before dispatch.", http.StatusConflict)
		out.Retry.Note = "Emergency stop before dispatch; the runner was not started."
	}
	return finish(req, out)
}

func isContextStop(_ context.Context, err error) bool {
	if err == nil {
		return false
	}
	var ee *EngineError
	if errors.As(err, &ee) {
		return false
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
