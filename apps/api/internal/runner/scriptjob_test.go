package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
)

func TestScriptRuntimeFromEnv(t *testing.T) {
	rt, status, err := ScriptRuntimeFromEnv(func(string) string { return "" }, os.ReadFile)
	if err != nil || status != ScriptJobsAPIUnconfigured {
		t.Fatalf("status %s err %v", status, err)
	}
	jobRT, ok := rt.(scripts.KubernetesJobRuntime)
	if !ok || jobRT.Submitter != nil || jobRT.Namespace != "flowforge" {
		t.Fatalf("runtime %#v", rt)
	}
	if jobRT.Name() != scripts.IsolationModeLive {
		t.Fatal(jobRT.Name())
	}

	const token = "script-runner-api-token-value"
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenPath, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	getenv := func(k string) string {
		switch k {
		case "SCRIPT_RUNNER_API_SERVER":
			return "https://kubernetes.default.svc"
		case "SCRIPT_RUNNER_TOKEN_FILE":
			return tokenPath
		case "SCRIPT_RUNNER_NAMESPACE":
			return "flowforge"
		default:
			return ""
		}
	}
	rt, status, err = ScriptRuntimeFromEnv(getenv, os.ReadFile)
	if err != nil || status != ScriptJobsConfigured {
		t.Fatalf("configured status %s err %v", status, err)
	}
	jobRT, ok = rt.(scripts.KubernetesJobRuntime)
	if !ok || jobRT.Submitter == nil {
		t.Fatal("missing client")
	}
	if err != nil && strings.Contains(err.Error(), token) {
		t.Fatal(err)
	}

	_, status, err = ScriptRuntimeFromEnv(func(k string) string {
		if k == "SCRIPT_RUNNER_TOKEN_FILE" {
			return tokenPath
		}
		return ""
	}, os.ReadFile)
	if err == nil || status != ScriptJobsTokenWithoutAPI || strings.Contains(err.Error(), token) {
		t.Fatalf("half config %s %v", status, err)
	}

	_, status, err = ScriptRuntimeFromEnv(func(k string) string {
		if k == "SCRIPT_RUNNER_TEMPLATE" {
			return filepath.Join(dir, "missing.yaml")
		}
		return ""
	}, os.ReadFile)
	if err == nil || status != ScriptJobsTemplateUnreadable {
		t.Fatalf("template %s %v", status, err)
	}
}
