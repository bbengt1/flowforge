package policy

import (
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
)

func TestEvaluateAllowsWhenNoPolicyBound(t *testing.T) {
	yamlDoc := workflowYAML("11111111-1111-4111-8111-111111111111", "cp-ops-nprd")
	out, err := Evaluate(Input{
		YAML: yamlDoc,
		Pins: []opsconfig.Pin{{
			Kind: opsconfig.KindClusterTarget, ResourceID: "11111111-1111-4111-8111-111111111111",
			VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("a", 64),
			Spec: map[string]any{"credentialId": "33333333-3333-4333-8333-333333333333", "endpoint": map[string]any{"apiServer": "https://kube.example"}},
		}},
		Now: time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionAllow || !out.DispatchAllowed || len(out.Requirements) != 0 {
		t.Fatalf("eval = %+v", out)
	}
}

func TestEvaluateDeniesNamespaceOutsideAllowlist(t *testing.T) {
	policyID := "44444444-4444-4444-8444-444444444444"
	targetID := "11111111-1111-4111-8111-111111111111"
	out, err := Evaluate(Input{
		YAML: workflowYAML(targetID, "cp-ops-nprd"),
		Pins: []opsconfig.Pin{
			{
				Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
				VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
				Spec: map[string]any{"policyId": policyID, "credentialId": "33333333-3333-4333-8333-333333333333", "endpoint": map[string]any{"apiServer": "https://kube.example"}},
			},
			{
				Kind: opsconfig.KindPolicy, ResourceID: policyID,
				VersionID: "55555555-5555-4555-8555-555555555555", VersionNumber: 2, Digest: "sha256:" + strings.Repeat("c", 64),
				Spec: map[string]any{"kind": "kubernetes", "policy": map[string]any{"namespaces": []string{"prod"}}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionDeny || out.DispatchAllowed || len(out.Denied) != 1 {
		t.Fatalf("eval = %+v", out)
	}
}

func TestEvaluateRequireApprovalBindsVersionTargetPolicyAndExpiry(t *testing.T) {
	now := time.Date(2026, 9, 9, 15, 0, 0, 0, time.UTC)
	policyID := "44444444-4444-4444-8444-444444444444"
	targetID := "11111111-1111-4111-8111-111111111111"
	policyVer := "55555555-5555-4555-8555-555555555555"
	targetVer := "22222222-2222-4222-8222-222222222222"
	out, err := Evaluate(Input{
		YAML:              workflowYAML(targetID, "prod"),
		WorkflowVersionID: "66666666-6666-4666-8666-666666666666",
		WorkflowDigest:    "sha256:" + strings.Repeat("d", 64),
		Now:               now,
		Pins: []opsconfig.Pin{
			{
				Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
				VersionID: targetVer, VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
				Spec: map[string]any{"policyId": policyID, "credentialId": "33333333-3333-4333-8333-333333333333", "endpoint": map[string]any{"apiServer": "https://kube.example"}},
			},
			{
				Kind: opsconfig.KindPolicy, ResourceID: policyID,
				VersionID: policyVer, VersionNumber: 3, Digest: "sha256:" + strings.Repeat("c", 64),
				Spec: map[string]any{"kind": "kubernetes", "policy": map[string]any{
					"allowedNamespaces": []string{"prod"},
					"requireApproval":   true,
					"approverRole":      "approver",
					"expiresIn":         "PT30M",
				}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionApprovalRequired || out.DispatchAllowed || len(out.Requirements) != 1 {
		t.Fatalf("eval = %+v", out)
	}
	req := out.Requirements[0]
	if req.Operation != "kubernetes.apply" || req.TargetID != targetID || req.TargetVersionID != targetVer {
		t.Fatalf("target bind = %+v", req)
	}
	if req.PolicyResourceID != policyID || req.PolicyVersionID != policyVer || req.PolicyRevision != 3 {
		t.Fatalf("policy bind = %+v", req)
	}
	if !req.ExpiresAt.Equal(now.Add(30*time.Minute)) || req.ApproverRole != "approver" {
		t.Fatalf("expiry/role = %+v", req)
	}
}

func TestEvaluateFlowApprovalAlwaysRequiresApproval(t *testing.T) {
	yamlDoc := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: wait-for-change
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Approve
      with:
        approverRole: approver
        expiresIn: PT15M
  edges: []
`
	out, err := Evaluate(Input{YAML: yamlDoc, Now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionAllow || !out.DispatchAllowed || len(out.Requirements) != 1 {
		t.Fatalf("eval = %+v", out)
	}
	if !out.Requirements[0].Wait || out.Requirements[0].ExpiresIn != "PT15M" || out.Requirements[0].Operation != "flow.approval" {
		t.Fatalf("req = %+v", out.Requirements[0])
	}
}

func TestEvaluateEmptyAllowlistsFailClosed(t *testing.T) {
	policyID := "44444444-4444-4444-8444-444444444444"
	targetID := "11111111-1111-4111-8111-111111111111"
	out, err := Evaluate(Input{
		YAML: workflowYAML(targetID, "prod"),
		Pins: []opsconfig.Pin{
			{
				Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
				VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
				Spec: map[string]any{"policyId": policyID, "credentialId": "33333333-3333-4333-8333-333333333333", "endpoint": map[string]any{"apiServer": "https://kube.example"}},
			},
			{
				Kind: opsconfig.KindPolicy, ResourceID: policyID,
				VersionID: "55555555-5555-4555-8555-555555555555", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("c", 64),
				Spec: map[string]any{"kind": "kubernetes", "policy": map[string]any{"allowedNamespaces": []any{}, "allowedKinds": []any{}, "allowedVerbs": []any{}}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionDeny {
		t.Fatalf("empty present allowlists must deny, got %+v", out)
	}
}

func TestEvaluateTargetNamespaceAllowlist(t *testing.T) {
	targetID := "11111111-1111-4111-8111-111111111111"
	out, err := Evaluate(Input{
		YAML: workflowYAML(targetID, "staging"),
		Pins: []opsconfig.Pin{{
			Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
			VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
			Spec: map[string]any{
				"credentialId":      "33333333-3333-4333-8333-333333333333",
				"endpoint":          map[string]any{"apiServer": "https://kube.example"},
				"allowedNamespaces": []string{"prod"},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionDeny {
		t.Fatalf("target allowlist must deny, got %+v", out)
	}
}

func TestEvaluateRolloutStatusUsesWatchVerb(t *testing.T) {
	policyID := "44444444-4444-4444-8444-444444444444"
	targetID := "11111111-1111-4111-8111-111111111111"
	yamlDoc := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: wait-rollout
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: wait
      type: kubernetes.rolloutStatus
      name: Wait
      with:
        clusterTargetId: ` + targetID + `
        namespace: prod
        resource:
          kind: Deployment
          name: api
  edges: []
`
	pins := func(verbs []string) []opsconfig.Pin {
		return []opsconfig.Pin{
			{
				Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
				VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
				Spec: map[string]any{"policyId": policyID, "credentialId": "33333333-3333-4333-8333-333333333333", "endpoint": map[string]any{"apiServer": "https://kube.example"}},
			},
			{
				Kind: opsconfig.KindPolicy, ResourceID: policyID,
				VersionID: "55555555-5555-4555-8555-555555555555", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("c", 64),
				Spec: map[string]any{"kind": "kubernetes", "policy": map[string]any{
					"allowedNamespaces": []string{"prod"},
					"allowedVerbs":      verbs,
				}},
			},
		}
	}
	denied, err := Evaluate(Input{YAML: yamlDoc, Pins: pins([]string{"get"})})
	if err != nil {
		t.Fatal(err)
	}
	if denied.Decision != DecisionDeny {
		t.Fatalf("get must not grant rolloutStatus, got %+v", denied)
	}
	allowed, err := Evaluate(Input{YAML: yamlDoc, Pins: pins([]string{"watch"})})
	if err != nil {
		t.Fatal(err)
	}
	if allowed.Decision != DecisionAllow {
		t.Fatalf("watch must allow rolloutStatus, got %+v", allowed)
	}
}

func TestEvaluateVerbAllowlist(t *testing.T) {
	policyID := "44444444-4444-4444-8444-444444444444"
	targetID := "11111111-1111-4111-8111-111111111111"
	out, err := Evaluate(Input{
		YAML: workflowYAML(targetID, "prod"),
		Pins: []opsconfig.Pin{
			{
				Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
				VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
				Spec: map[string]any{"policyId": policyID, "credentialId": "33333333-3333-4333-8333-333333333333", "endpoint": map[string]any{"apiServer": "https://kube.example"}},
			},
			{
				Kind: opsconfig.KindPolicy, ResourceID: policyID,
				VersionID: "55555555-5555-4555-8555-555555555555", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("c", 64),
				Spec: map[string]any{"kind": "kubernetes", "policy": map[string]any{
					"allowedNamespaces": []string{"prod"},
					"allowedVerbs":      []string{"get"},
				}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionDeny {
		t.Fatalf("verb allowlist must deny apply, got %+v", out)
	}
}

func TestEvaluateMissingPublishedPolicyFailsClosed(t *testing.T) {
	targetID := "11111111-1111-4111-8111-111111111111"
	out, err := Evaluate(Input{
		YAML: workflowYAML(targetID, "prod"),
		Pins: []opsconfig.Pin{{
			Kind: opsconfig.KindClusterTarget, ResourceID: targetID,
			VersionID: "22222222-2222-4222-8222-222222222222", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
			Spec: map[string]any{
				"policyId":     "44444444-4444-4444-8444-444444444444",
				"credentialId": "33333333-3333-4333-8333-333333333333",
				"endpoint":     map[string]any{"apiServer": "https://kube.example"},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Decision != DecisionDeny {
		t.Fatalf("missing policy must deny, got %+v", out)
	}
}

func TestEvaluateSSHRetryDefaultsToZero(t *testing.T) {
	targetID := "11111111-1111-4111-8111-111111111111"
	profileID := "22222222-2222-4222-8222-222222222222"
	yamlDoc := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ssh-retry
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: ssh.run
      name: Run
      with:
        sshTargetId: ` + targetID + `
        commandProfileId: ` + profileID + `
  edges: []
`
	out, err := Evaluate(Input{
		YAML: yamlDoc,
		Pins: []opsconfig.Pin{
			{
				Kind: opsconfig.KindSSHTarget, ResourceID: targetID,
				VersionID: "33333333-3333-4333-8333-333333333333", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("a", 64),
				Spec: map[string]any{"hostname": "edge.example", "hostKeyFingerprint": "sha256:" + strings.Repeat("1", 64), "credentialId": "44444444-4444-4444-8444-444444444444"},
			},
			{
				Kind: opsconfig.KindCommandProfile, ResourceID: profileID,
				VersionID: "55555555-5555-4555-8555-555555555555", VersionNumber: 1, Digest: "sha256:" + strings.Repeat("b", 64),
				Spec: map[string]any{"retrySafe": false, "template": "true", "parameterSchema": map[string]any{"type": "object"}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Operations) != 1 {
		t.Fatalf("ops = %+v", out.Operations)
	}
	op := out.Operations[0]
	if op.RetryMaxAttempts != 0 || op.RetryAllowed || op.RetrySafe {
		t.Fatalf("ssh retry evaluate = %+v", op)
	}
}

func workflowYAML(targetID, ns string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: kubernetes.apply
      name: Restart API
      with:
        clusterTargetId: ` + targetID + `
        namespace: ` + ns + `
        dryRun: server
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
  edges: []
`
}
