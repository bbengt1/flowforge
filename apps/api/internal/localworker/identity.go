package localworker

import (
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Worker identity. The compose worker presents its own trusted-dev
// principal, never a human admin's. The API binds that principal in the
// local workbench with WorkerRole only (see localseed.EnsureWorker).
const (
	EnvWorkerIssuer  = "WORKER_ISSUER"
	EnvWorkerSubject = "WORKER_SUBJECT"

	DefaultIssuer  = "https://idp.example"
	DefaultSubject = "compose-worker"
	DisplayName    = "Compose worker"

	// WorkerRole is the smallest existing role that grants
	// workflow.execute, which claim, heartbeat, complete, fail, and
	// release require. It does not grant approval.decide or
	// workspace.administer, so the worker is never an approver
	// candidate, an eligible decider, or another active admin.
	WorkerRole = authz.RoleOperator
)

// Identity returns the worker principal: WORKER_ISSUER / WORKER_SUBJECT
// when set, otherwise the defaults. Each half falls back on its own.
func Identity(issuer, subject string) authz.PrincipalRef {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	if issuer == "" {
		issuer = DefaultIssuer
	}
	if subject == "" {
		subject = DefaultSubject
	}
	return authz.PrincipalRef{Issuer: issuer, Subject: subject}
}

// BindingEnabled reports whether the API should bind the worker
// principal at startup: trusted-dev identity headers are on (the only
// way the worker authenticates), the process is not production-locked,
// and LOCAL_WORKER is not an explicit off value. It never errors; the
// worker binary itself refuses an explicit on in a locked environment.
func BindingEnabled(flag, appEnv string, requireTLS, trustHeaders bool) bool {
	if !trustHeaders || authz.ProductionLocked(appEnv, requireTLS) {
		return false
	}
	return !falsyEnv(flag)
}
