package imagehealth

import (
	"path/filepath"
	"strings"
)

// NeedsHTTPProbe reports whether pid 1 is the API and the image health
// check must call GET /api/v1/health. The runner, local worker, migrate,
// kek-rotate, and slug-backfill commands do not listen, so a live pid 1 is
// enough.
func NeedsHTTPProbe(cmdline string) bool {
	fields := strings.Fields(strings.ReplaceAll(cmdline, "\x00", " "))
	if len(fields) == 0 {
		return true
	}
	switch filepath.Base(fields[0]) {
	case "runner", "worker", "migrate", "kek-rotate", "slug-backfill":
		return false
	default:
		return true
	}
}

// ExitCode is 0 when the process is healthy. probe is called only when
// pid 1 serves HTTP. A probe error is exit 1.
func ExitCode(cmdline string, probe func() error) int {
	if !NeedsHTTPProbe(cmdline) {
		return 0
	}
	if probe == nil || probe() != nil {
		return 1
	}
	return 0
}
