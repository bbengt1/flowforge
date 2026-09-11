// Package localworker is the local/dev compose job runner. It claims
// through POST /api/v1/jobs/claim and honors the same lease, HMAC ticket,
// and fencing checks as any other worker. It is not a production worker
// path: production-locked APP_ENV or REQUIRE_TLS refuses to start.
package localworker

import (
	"fmt"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// EnvLocalWorker is the explicit enable/opt-out flag.
const EnvLocalWorker = "LOCAL_WORKER"

// CodeUnsupported is the fail-closed error code when this worker cannot
// execute a node (provider engines, durable delay). The job leaves queued.
const CodeUnsupported = "local-worker-unsupported"

// Resolve decides whether the compose/local worker binary may run.
//
// Enabled when APP_ENV is development|dev|local|test, REQUIRE_TLS is
// false, and LOCAL_WORKER is not an explicit off value.
// Production-locked APP_ENV or REQUIRE_TLS=true is a no-op unless the
// flag is explicitly on, in which case config load / process start
// refuses so the leftover cannot stay enabled accidentally.
func Resolve(flag, appEnv string, requireTLS bool) (bool, error) {
	on := truthyEnv(flag)
	if authz.ProductionLocked(appEnv, requireTLS) {
		if on {
			return false, fmt.Errorf("%s cannot be enabled when %s is empty/production/unknown or REQUIRE_TLS=true", EnvLocalWorker, authz.EnvAppEnv)
		}
		return false, nil
	}
	if falsyEnv(flag) {
		return false, nil
	}
	return true, nil
}

func truthyEnv(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func falsyEnv(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "0", "false", "no", "off":
		return true
	default:
		return false
	}
}
