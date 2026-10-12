package fixturesuite

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
)

// Nightly evidence (S4). FIXTURESUITE_DRIVERS=compose[,runner] limits the
// drivers run; FIXTURESUITE_RESULTS=<file> appends one JSON line per part
// (fixtures and security checks) with its outcome, failures and pending
// keys, for the workflow artifact.

func driverSelected(name string) bool {
	sel := strings.TrimSpace(os.Getenv("FIXTURESUITE_DRIVERS"))
	if sel == "" {
		return true
	}
	for _, d := range strings.Split(sel, ",") {
		if strings.TrimSpace(d) == name {
			return true
		}
	}
	return false
}

// Result is one evidence line.
type Result struct {
	Suite    string   `json:"suite"` // fixtures | security
	ID       string   `json:"id"`
	Part     string   `json:"part"`
	Driver   string   `json:"driver"`
	Build    string   `json:"build"` // fftest | default
	Outcome  Outcome  `json:"outcome"`
	Failures []string `json:"failures,omitempty"`
	Pending  []string `json:"pending,omitempty"`
	XFail    string   `json:"xfailIssue,omitempty"`
}

var resultsMu sync.Mutex

func recordResult(t *testing.T, r Result) {
	t.Helper()
	path := os.Getenv("FIXTURESUITE_RESULTS")
	if path == "" {
		return
	}
	r.Build = "default"
	if fftestBuild {
		r.Build = "fftest"
	}
	line, err := json.Marshal(r)
	if err != nil {
		t.Errorf("results: %v", err)
		return
	}
	resultsMu.Lock()
	defer resultsMu.Unlock()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Errorf("results: %v", err)
		return
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		t.Errorf("results: %v", err)
	}
}
