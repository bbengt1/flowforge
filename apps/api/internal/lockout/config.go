package lockout

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// EnvMaxFailures is the durable failure threshold. Unset uses
// DefaultMaxFailures. Zero, negative, and non-integers are a boot-fail
// so lockout cannot be turned off by a bad value.
const EnvMaxFailures = "LOCKOUT_MAX_FAILURES"

// LoadMaxFailures reads LOCKOUT_MAX_FAILURES.
func LoadMaxFailures() (int, error) {
	raw := strings.TrimSpace(os.Getenv(EnvMaxFailures))
	if raw == "" {
		return DefaultMaxFailures, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < MinMaxFailures || n > MaxMaxFailures {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", EnvMaxFailures, MinMaxFailures, MaxMaxFailures)
	}
	return n, nil
}
