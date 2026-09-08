package workflow

import (
	"strings"
	"testing"
)

func TestNormalizeIsDeterministic(t *testing.T) {
	reordered := `kind: Workflow
apiVersion: flowforge/v1
metadata:
  labels:
    team: platform
  name: restart-api-rollout
spec:
  nodes:
    - name: Restart API
      id: restart
      type: kubernetes.apply
      with:
        wait: ready
        timeoutSeconds: 300
        namespace: cp-ops-nprd
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
          spec:
            template:
              metadata:
                annotations:
                  kubectl.kubernetes.io/restartedAt: "2026-09-04T12:00:00Z"
        fieldManager: flowforge
        dryRun: server
        clusterTargetId: 11111111-1111-4111-8111-111111111111
  triggers:
    - type: manual
      id: manual
  description: Restart an approved deployment and wait for it to become ready.
  outputs:
    - from: restart.result
      name: rollout
  edges: []
`

	a, aErrs := ParseAndNormalize([]byte(validRestartYAML))
	if len(aErrs) > 0 {
		t.Fatalf("canonical: %+v", aErrs)
	}
	b, bErrs := ParseAndNormalize([]byte(reordered))
	if len(bErrs) > 0 {
		t.Fatalf("reordered: %+v", bErrs)
	}
	if a.NormalizedYAML != b.NormalizedYAML {
		t.Fatalf("normalized YAML differed\n--- a\n%s\n--- b\n%s", a.NormalizedYAML, b.NormalizedYAML)
	}
	if a.Digest != b.Digest || !strings.HasPrefix(a.Digest, "sha256:") {
		t.Fatalf("digests a=%s b=%s", a.Digest, b.Digest)
	}
	if a.Summary.Name != "restart-api-rollout" || len(a.Summary.Nodes) != 1 {
		t.Fatalf("summary = %+v", a.Summary)
	}

	again, errs := ParseAndNormalize([]byte(a.NormalizedYAML))
	if len(errs) > 0 {
		t.Fatalf("round trip: %+v", errs)
	}
	if again.Digest != a.Digest {
		t.Fatalf("normalized YAML is not stable: %s vs %s\n%s", a.Digest, again.Digest, again.NormalizedYAML)
	}
}

func TestNormalizePreservesLiteralBlocks(t *testing.T) {
	res, errs := ParseAndNormalize([]byte(validRestartYAML))
	if len(errs) > 0 {
		t.Fatalf("%+v", errs)
	}
	if !strings.Contains(res.NormalizedYAML, "kind: Deployment") {
		t.Fatalf("manifest lost: %s", res.NormalizedYAML)
	}
	if !strings.Contains(res.NormalizedYAML, "kubectl.kubernetes.io/restartedAt") {
		t.Fatalf("annotation lost: %s", res.NormalizedYAML)
	}
}

func TestCatalogExposesCorePorts(t *testing.T) {
	cat := CoreCatalog()
	if cat.APIVersion != APIVersionV1 {
		t.Fatalf("apiVersion = %s", cat.APIVersion)
	}
	found := false
	for _, n := range cat.Nodes {
		if n.Type == "kubernetes.apply" && n.Phase == PhaseCore {
			if _, ok := n.outputPort("result"); !ok {
				t.Fatal("kubernetes.apply missing result port")
			}
			found = true
		}
	}
	if !found {
		t.Fatal("core catalog missing kubernetes.apply")
	}
}
