package httpapi

import (
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestWithHTTPTestIdentitySuppliesTestHMACKeys(t *testing.T) {
	t.Setenv(wfstore.EnvJobBindingSecret, "")
	t.Setenv(scripts.EnvScriptSigningKey, "")
	d := withHTTPTestIdentity(Deps{})
	if len(d.JobBindingKey) != 32 || len(d.ScriptSigningKey) != 32 {
		t.Fatalf("test helper keys job=%d script=%d", len(d.JobBindingKey), len(d.ScriptSigningKey))
	}
}

func TestNewWithDepsLoadsHMACKeysFromEnvOnly(t *testing.T) {
	rawJob := []byte("flowforge-http-test-job-bind-32!")
	rawScript := []byte("flowforge-http-test-script-sg32!")
	if len(rawJob) != 32 || len(rawScript) != 32 {
		t.Fatalf("fixtures job=%d script=%d", len(rawJob), len(rawScript))
	}
	t.Setenv(wfstore.EnvJobBindingSecret, string(rawJob))
	t.Setenv(scripts.EnvScriptSigningKey, string(rawScript))

	loadedJob, err := wfstore.LoadJobBindingKey()
	if err != nil {
		t.Fatal(err)
	}
	loadedScript, err := scripts.LoadSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(loadedJob) != string(rawJob) || string(loadedScript) != string(rawScript) {
		t.Fatal("env keys must load without generating a replacement")
	}

	t.Setenv(wfstore.EnvJobBindingSecret, "")
	t.Setenv(scripts.EnvScriptSigningKey, "")
	if _, err := wfstore.LoadJobBindingKey(); err == nil {
		t.Fatal("empty JOB_BINDING_SECRET must fail closed")
	}
	if _, err := scripts.LoadSigningKey(); err == nil {
		t.Fatal("empty SCRIPT_SIGNING_KEY must fail closed")
	}
}
