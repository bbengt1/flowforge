package policy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
)

func TestEvaluateIdenticalWithAndWithoutLayout(t *testing.T) {
	targetID := "11111111-1111-4111-8111-111111111111"
	without := workflowYAML(targetID, "cp-ops-nprd")
	with := strings.Replace(without, "metadata:\n  name: restart-api-rollout\n", `metadata:
  name: restart-api-rollout
  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 120, y: 80 }
        ghost: { x: 1, y: 2 }
`, 1)
	if !strings.Contains(with, "metadata.ui") && !strings.Contains(with, "layout:") {
		t.Fatal("failed to inject layout")
	}

	pins := []opsconfig.Pin{{
		Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
		VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("a", 64),
		Spec: map[string]any{"credentialId": "33333333-3333-4333-8333-333333333333", "endpoint": map[string]any{"apiServer": "https://kube.example"}},
	}}
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)
	left, err := Evaluate(Input{YAML: without, Pins: pins, Now: now, WorkflowVersionID: "ver", WorkflowDigest: "sha256:aaa"})
	if err != nil {
		t.Fatal(err)
	}
	right, err := Evaluate(Input{YAML: with, Pins: pins, Now: now, WorkflowVersionID: "ver", WorkflowDigest: "sha256:aaa"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(canonicalEval(left), canonicalEval(right)) {
		t.Fatalf("policy evaluate drifted\nwithout=%s\nwith=%s", mustEvalJSON(left), mustEvalJSON(right))
	}
}

func canonicalEval(in Result) Result {
	in.EvaluatedAt = time.Time{}
	return in
}

func mustEvalJSON(v Result) string {
	raw, err := json.Marshal(canonicalEval(v))
	if err != nil {
		return err.Error()
	}
	return string(raw)
}
