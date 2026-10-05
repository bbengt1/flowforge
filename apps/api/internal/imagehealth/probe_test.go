package imagehealth

import (
	"errors"
	"testing"
)

func TestRunnerDoesNotProbeHTTP(t *testing.T) {
	called := false
	code := ExitCode("/usr/local/bin/runner\x00", func() error {
		called = true
		return errors.New("down")
	})
	if code != 0 || called {
		t.Fatalf("code=%d called=%v", code, called)
	}
	for _, cmd := range []string{
		"/usr/local/bin/worker",
		"/usr/local/bin/migrate",
		"/usr/local/bin/kek-rotate",
	} {
		if NeedsHTTPProbe(cmd) {
			t.Fatalf("%s should not use port 8080", cmd)
		}
	}
}

func TestAPIProbesHTTP(t *testing.T) {
	if !NeedsHTTPProbe("/usr/local/bin/api") {
		t.Fatal("api must probe HTTP")
	}
	if ExitCode("/usr/local/bin/api", func() error { return nil }) != 0 {
		t.Fatal("healthy api")
	}
	if ExitCode("/usr/local/bin/api", func() error { return errors.New("down") }) == 0 {
		t.Fatal("unhealthy api must fail")
	}
	if ExitCode("", func() error { return errors.New("down") }) == 0 {
		t.Fatal("empty cmdline fails closed onto the HTTP probe")
	}
}
