package ssh

import "strings"

// AuditSnapshot is the secret-free ssh.run record for jobs and audit_events.
// It never includes private keys, passphrases, rendered commands, or raw logs.
type AuditSnapshot struct {
	ActorID           string         `json:"actorId,omitempty"`
	Operation         string         `json:"operation"`
	SSHTargetID       string         `json:"sshTargetId,omitempty"`
	CommandProfileID  string         `json:"commandProfileId,omitempty"`
	ProfileRevision   string         `json:"profileRevision,omitempty"`
	ProfileDigest     string         `json:"profileDigest,omitempty"`
	ParameterNames    []string       `json:"parameterNames,omitempty"`
	Parameters        map[string]any `json:"parameters,omitempty"`
	Hostname          string         `json:"hostname,omitempty"`
	Port              int            `json:"port,omitempty"`
	Username          string         `json:"username,omitempty"`
	ResolvedAddresses []string       `json:"resolvedAddresses,omitempty"`
	ConnectedAddress  string         `json:"connectedAddress,omitempty"`
	ExitCode          *int           `json:"exitCode,omitempty"`
	Outcome           string         `json:"outcome"`
	CorrelationID     string         `json:"correlationId,omitempty"`
	ErrorCode         string         `json:"errorCode,omitempty"`
	PolicyRevision    string         `json:"policyRevision,omitempty"`
	PolicyDigest      string         `json:"policyDigest,omitempty"`
	RetryMaxAttempts      int            `json:"retryMaxAttempts"`
	RetrySafe             bool           `json:"retrySafe"`
	RetryAllowed          bool           `json:"retryAllowed"`
	VerificationOutcome   string         `json:"verificationOutcome,omitempty"`
}

// SnapshotAudit builds a redacted audit view of an engine result.
func SnapshotAudit(req Request, res Result) AuditSnapshot {
	outcome := "success"
	var code string
	if res.Error != nil {
		outcome = "failure"
		code = res.Error.Code
		if res.Error.Code == CodeIndeterminate {
			outcome = "indeterminate"
		}
	} else if !res.OK {
		outcome = "failure"
	}
	names := append([]string(nil), res.ParameterNames...)
	if len(names) == 0 {
		for name := range req.Parameters {
			names = append(names, name)
		}
	}
	params := res.Parameters
	if params == nil && req.Parameters != nil {
		params = map[string]any{}
		for name := range req.Parameters {
			params[name] = redactedMarker
		}
	}
	snap := AuditSnapshot{
		ActorID:           strings.TrimSpace(req.ActorID),
		Operation:         res.Operation,
		SSHTargetID:       res.SSHTargetID,
		CommandProfileID:  res.CommandProfileID,
		ProfileRevision:   res.ProfileRevision,
		ProfileDigest:     res.ProfileDigest,
		ParameterNames:    names,
		Parameters:        params,
		Hostname:          res.Hostname,
		Port:              res.Port,
		Username:          res.Username,
		ResolvedAddresses: append([]string(nil), res.ResolvedAddresses...),
		ConnectedAddress:  res.ConnectedAddress,
		ExitCode:          res.ExitCode,
		Outcome:           outcome,
		CorrelationID:     res.CorrelationID,
		ErrorCode:         code,
		PolicyRevision:    res.PolicyRevision,
		PolicyDigest:      res.PolicyDigest,
		RetryMaxAttempts:  res.Retry.MaxAttempts,
		RetrySafe:         res.Retry.RetrySafe,
		RetryAllowed:      res.Retry.Allowed,
	}
	if res.Retry.Verification != nil {
		snap.VerificationOutcome = res.Retry.Verification.Outcome
	}
	return snap
}

func auditMap(snap AuditSnapshot) map[string]any {
	raw := map[string]any{
		"operation":        snap.Operation,
		"sshTargetId":      snap.SSHTargetID,
		"commandProfileId": snap.CommandProfileID,
		"profileRevision":  snap.ProfileRevision,
		"profileDigest":    snap.ProfileDigest,
		"hostname":         snap.Hostname,
		"port":             snap.Port,
		"username":         snap.Username,
		"connectedAddress": snap.ConnectedAddress,
		"correlationId":    snap.CorrelationID,
		"outcome":          snap.Outcome,
		"retryMaxAttempts": snap.RetryMaxAttempts,
		"retrySafe":        snap.RetrySafe,
		"retryAllowed":     snap.RetryAllowed,
		"policyRevision":   snap.PolicyRevision,
		"policyDigest":     snap.PolicyDigest,
	}
	if snap.VerificationOutcome != "" {
		raw["verificationOutcome"] = snap.VerificationOutcome
	}
	if snap.ActorID != "" {
		raw["actorId"] = snap.ActorID
	}
	if snap.ErrorCode != "" {
		raw["errorCode"] = snap.ErrorCode
	}
	if len(snap.ParameterNames) > 0 {
		raw["parameterNames"] = snap.ParameterNames
	}
	if len(snap.Parameters) > 0 {
		raw["parameters"] = snap.Parameters
	}
	if len(snap.ResolvedAddresses) > 0 {
		raw["resolvedAddresses"] = snap.ResolvedAddresses
	}
	if snap.ExitCode != nil {
		raw["exitCode"] = *snap.ExitCode
	}
	if v, ok := RedactValue(raw).(map[string]any); ok {
		return v
	}
	return raw
}

func attachAudit(req Request, res Result) Result {
	res.Audit = auditMap(SnapshotAudit(req, res))
	return res
}
