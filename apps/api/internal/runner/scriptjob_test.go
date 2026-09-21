package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
)

func TestScriptRuntimeFromEnv(t *testing.T) {
	rt, status, err := ScriptRuntimeFromEnv(func(string) string { return "" }, os.ReadFile, true)
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
		case scripts.EnvControlPlaneCIDR:
			return "203.0.113.10/32"
		default:
			return ""
		}
	}
	rt, status, err = ScriptRuntimeFromEnv(getenv, os.ReadFile, true)
	if err != nil || status != ScriptJobsConfigured {
		t.Fatalf("configured status %s err %v", status, err)
	}
	jobRT, ok = rt.(scripts.KubernetesJobRuntime)
	if !ok || jobRT.Submitter == nil {
		t.Fatal("missing client")
	}
	client, ok := jobRT.Submitter.(*scripts.APIJobClient)
	if !ok || !client.NetworkPolicyEnforced() {
		t.Fatal("production client must enforce the network policy")
	}
	if err != nil && strings.Contains(err.Error(), token) {
		t.Fatal(err)
	}

	_, status, err = ScriptRuntimeFromEnv(func(k string) string {
		if k == "SCRIPT_RUNNER_TOKEN_FILE" {
			return tokenPath
		}
		return ""
	}, os.ReadFile, true)
	if err == nil || status != ScriptJobsTokenWithoutAPI || strings.Contains(err.Error(), token) {
		t.Fatalf("half config %s %v", status, err)
	}

	_, status, err = ScriptRuntimeFromEnv(func(k string) string {
		if k == "SCRIPT_RUNNER_TEMPLATE" {
			return filepath.Join(dir, "missing.yaml")
		}
		return ""
	}, os.ReadFile, true)
	if err == nil || status != ScriptJobsTemplateUnreadable {
		t.Fatalf("template %s %v", status, err)
	}
}

func TestScriptRuntimeNetworkPolicyFailClosed(t *testing.T) {
	const token = "script-runner-api-token-value"
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	base := func(extra string) func(string) string {
		return func(k string) string {
			switch k {
			case "SCRIPT_RUNNER_API_SERVER":
				return "https://kubernetes.default.svc"
			case "SCRIPT_RUNNER_TOKEN_FILE":
				return tokenPath
			case scripts.EnvControlPlaneCIDR:
				return extra
			default:
				return ""
			}
		}
	}
	rt, status, err := ScriptRuntimeFromEnv(base(""), os.ReadFile, true)
	if err != nil || status != ScriptJobsNetworkPolicyUnconfigured {
		t.Fatalf("missing cidr status %s err %v", status, err)
	}
	jobRT, ok := rt.(scripts.KubernetesJobRuntime)
	if !ok {
		t.Fatalf("%T", rt)
	}
	if jobRT.Name() != scripts.IsolationModeLive {
		t.Fatal(jobRT.Name())
	}
	_, err = jobRT.Submitter.Submit(context.Background(), map[string]any{"kind": "Job"})
	var ee *scripts.EngineError
	if !errors.As(err, &ee) || ee.Code != scripts.CodeNetworkPolicyDenied {
		t.Fatalf("submit %v", err)
	}
	if strings.Contains(err.Error(), token) {
		t.Fatal(err)
	}

	_, status, err = ScriptRuntimeFromEnv(func(k string) string {
		switch k {
		case "SCRIPT_RUNNER_API_SERVER":
			return "https://kubernetes.default.svc"
		case "SCRIPT_RUNNER_TOKEN_FILE":
			return tokenPath
		case scripts.EnvSkipScriptNetworkPolicy:
			return "true"
		default:
			return ""
		}
	}, os.ReadFile, true)
	if err == nil || status != ScriptJobsNetworkPolicySkipForbidden || strings.Contains(err.Error(), token) {
		t.Fatalf("skip in prod %s %v", status, err)
	}

	rt, status, err = ScriptRuntimeFromEnv(func(k string) string {
		switch k {
		case "SCRIPT_RUNNER_API_SERVER":
			return "https://kubernetes.default.svc"
		case "SCRIPT_RUNNER_TOKEN_FILE":
			return tokenPath
		case scripts.EnvSkipScriptNetworkPolicy:
			return "true"
		default:
			return ""
		}
	}, os.ReadFile, false)
	if err != nil || status != ScriptJobsConfigured {
		t.Fatalf("dev skip %s %v", status, err)
	}
	jobRT = rt.(scripts.KubernetesJobRuntime)
	client, ok := jobRT.Submitter.(*scripts.APIJobClient)
	if !ok || client.NetworkPolicyEnforced() {
		t.Fatal("local skip must be explicit and must not enforce")
	}

	_, status, err = ScriptRuntimeFromEnv(func(k string) string {
		if k == scripts.EnvSkipScriptNetworkPolicy {
			return "true"
		}
		return ""
	}, os.ReadFile, true)
	if err == nil || status != ScriptJobsNetworkPolicySkipForbidden {
		t.Fatalf("skip without API still forbidden in prod %s %v", status, err)
	}

	_, status, err = ScriptRuntimeFromEnv(base("0.0.0.0/0"), os.ReadFile, true)
	if err == nil || status != ScriptJobsNetworkPolicyInvalid || strings.Contains(err.Error(), token) {
		t.Fatalf("world cidr %s %v", status, err)
	}

	rt, status, err = ScriptRuntimeFromEnv(func(k string) string {
		switch k {
		case "SCRIPT_RUNNER_API_SERVER":
			return "https://kubernetes.default.svc"
		case "SCRIPT_RUNNER_TOKEN_FILE":
			return tokenPath
		case scripts.EnvControlPlaneService:
			return "flowforge-api"
		case scripts.EnvControlPlaneServiceNamespace:
			return "flowforge"
		default:
			return ""
		}
	}, os.ReadFile, true)
	if err != nil || status != ScriptJobsConfigured {
		t.Fatalf("service %s %v", status, err)
	}
	client, ok = rt.(scripts.KubernetesJobRuntime).Submitter.(*scripts.APIJobClient)
	if !ok || !client.NetworkPolicyEnforced() {
		t.Fatal("service mode must still enforce the policy")
	}
}
