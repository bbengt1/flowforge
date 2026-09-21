package scripts

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestParseControlPlaneEnv(t *testing.T) {
	_, err := ParseControlPlaneEnv("", "", "", "")
	if !errors.Is(err, ErrControlPlaneMissing) {
		t.Fatal(err)
	}
	for _, cidr := range []string{"0.0.0.0/0", "::/0", "203.0.113.10", "not-a-cidr", "10.0.0.1/24"} {
		_, err = ParseControlPlaneEnv(cidr, "", "", "")
		if !errors.Is(err, ErrControlPlaneInvalid) {
			t.Fatalf("%s: %v", cidr, err)
		}
	}
	cfg, err := ParseControlPlaneEnv("203.0.113.10/32", "", "", "")
	if err != nil || cfg.Port != 443 || cfg.CIDR != "203.0.113.10/32" {
		t.Fatalf("%+v %v", cfg, err)
	}
	_, err = ParseControlPlaneEnv("203.0.113.10/32", "443", "flowforge-api", "flowforge")
	if !errors.Is(err, ErrControlPlaneInvalid) {
		t.Fatal(err)
	}
	cfg, err = ParseControlPlaneEnv("", "8080", "flowforge-api", "flowforge")
	if err != nil || cfg.Port != 8080 || cfg.Service != "flowforge-api" {
		t.Fatalf("%+v %v", cfg, err)
	}
}

func TestDeployedScriptNetworkPolicyMatchesCIDRContract(t *testing.T) {
	root := findRepoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, "deploy/kubernetes/script-runner-networkpolicy.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, "${CONTROL_PLANE_API_CIDR}") {
		t.Fatal("CIDR must be substituted from deploy config")
	}
	substituted := strings.ReplaceAll(text, "${CONTROL_PLANE_API_CIDR}", "203.0.113.10/32")
	obj := decodePolicy(t, []byte(substituted))
	cfg, err := ParseControlPlaneEnv("203.0.113.10/32", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateScriptNetworkPolicy(obj, cfg); err != nil {
		t.Fatal(err)
	}
	obj["spec"].(map[string]any)["egress"] = append(obj["spec"].(map[string]any)["egress"].([]any), map[string]any{
		"to":    []any{map[string]any{"ipBlock": map[string]any{"cidr": "198.51.100.0/24"}}},
		"ports": []any{map[string]any{"protocol": "TCP", "port": float64(443)}},
	})
	if err := ValidateScriptNetworkPolicy(obj, cfg); err == nil {
		t.Fatal("extra egress must fail closed")
	}
}

func decodePolicy(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var doc any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	buf, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := json.Unmarshal(buf, &obj); err != nil {
		t.Fatal(err)
	}
	return obj
}
