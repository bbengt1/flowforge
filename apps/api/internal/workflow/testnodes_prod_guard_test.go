//go:build !fftest

package workflow

import "testing"

// Production (untagged) builds must not register any test-only node, and a
// workflow using test.flaky is refused with the normal unsupported-node code.
func TestProdBuildHasNoTestNodes(t *testing.T) {
	if IsTestNode("test.flaky") || len(TestNodeTypes()) != 0 {
		t.Fatalf("test nodes registered in an untagged build: %v", TestNodeTypes())
	}
	if _, ok := lookupNode("test.flaky"); ok {
		t.Fatal("lookupNode found test.flaky without -tags fftest")
	}
	for _, n := range CoreCatalog().Nodes {
		if n.Type == "test.flaky" {
			t.Fatal("catalog lists test.flaky")
		}
	}
	_, errs := Parse([]byte(`
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: flaky
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: flaky
      type: test.flaky
      name: Flaky
      with:
        failTimes: 1
  edges: []
`))
	assertHasCode(t, errs, CodeUnsupportedNode)
	if out := EvaluateTestStep("test.flaky", map[string]any{"failTimes": 0}, 1); !out.Fail {
		t.Fatal("EvaluateTestStep must fail closed untagged")
	}
}
