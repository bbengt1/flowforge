package runner

import (
	"fmt"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// EnvRunner opts the production runner out. Empty means enabled when
// the process is production-locked. 0/false/off/no exits cleanly.
const EnvRunner = "RUNNER"

// Resolve enables the production runner only in a production-locked
// environment. Local/dev/test (and REQUIRE_TLS false) is refused so
// compose keeps using cmd/worker.
func Resolve(flag, appEnv string, requireTLS bool) (bool, error) {
	if !authz.ProductionLocked(appEnv, requireTLS) {
		return false, fmt.Errorf("production runner refuses the local/dev path; use cmd/worker")
	}
	if explicitOff(flag) {
		return false, nil
	}
	return true, nil
}

func explicitOff(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "0", "false", "off", "no":
		return true
	default:
		return false
	}
}
