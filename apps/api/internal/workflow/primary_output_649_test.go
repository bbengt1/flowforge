package workflow

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCatalogPrimaryOutputIsDeclared649(t *testing.T) {
	for _, n := range CoreCatalog().Nodes {
		if n.PrimaryOutput == "" {
			continue
		}
		found := false
		for _, p := range n.Outputs {
			if p.Name == n.PrimaryOutput {
				found = true
			}
		}
		if !found || n.PrimaryOutput == ErrorPortName {
			t.Errorf("%s primaryOutput %q is not a declared output", n.Type, n.PrimaryOutput)
		}
	}
	want := map[string]string{
		"flow.fail": "result", "data.set": "result", "flow.condition": "", "flow.approval": "",
		// Data-port types (Gracie, #667): extra outputs fire together on
		// success, so result is primary and continue is allowed.
		"ssh.run": "result", "kubernetes.apply": "result", "kubernetes.get": "result",
		"kubernetes.list": "result", "kubernetes.rolloutStatus": "result",
	}
	seenData := 0
	for _, n := range CoreCatalog().Nodes {
		if _, ok := dataPortTypes[n.Type]; ok {
			seenData++
		}
	}
	if seenData != len(dataPortTypes) {
		t.Fatalf("catalog has %d of %d data-port types", seenData, len(dataPortTypes))
	}
	for _, n := range CoreCatalog().Nodes {
		if exp, ok := want[n.Type]; ok && n.PrimaryOutput != exp {
			t.Errorf("%s primaryOutput = %q, want %q", n.Type, n.PrimaryOutput, exp)
		}
	}
}

func TestCatalogJSONOmitsPrimaryOutputWhenNone649(t *testing.T) {
	raw, err := json.Marshal(CoreCatalog())
	if err != nil {
		t.Fatal(err)
	}
	var cat struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &cat); err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, n := range cat.Nodes {
		_, has := n["primaryOutput"]
		switch n["type"] {
		case "flow.condition", "flow.approval":
			seen++
			if has {
				t.Errorf("%s must omit primaryOutput", n["type"])
			}
		case "flow.fail":
			seen++
			if n["primaryOutput"] != "result" {
				t.Errorf("flow.fail primaryOutput = %v", n["primaryOutput"])
			}
		}
	}
	if seen != 3 {
		t.Fatalf("saw %d expected types", seen)
	}
}

func TestContinueRefusedWithoutPrimaryOutput649(t *testing.T) {
	cases := map[string]string{
		"gate": `    - id: gate
      type: flow.condition
      name: Gate
      onError: continue
      with:
        op: eq
        path: status
        compare: ready
`,
		"approve": `    - id: approve
      type: flow.approval
      name: Approve
      onError: continue
      with:
        approvers:
          - role: admin
`,
	}
	for nodeID, node := range cases {
		src := "apiVersion: flowforge/v1\nkind: Workflow\nmetadata:\n  name: continue-" + nodeID + "\nspec:\n  triggers:\n    - id: manual\n      type: manual\n  nodes:\n" + node
		_, errs := Parse([]byte(src))
		var hit *FieldError
		for i := range errs {
			if errs[i].Code == CodeOnErrorContinueNoPrimary {
				hit = &errs[i]
			}
		}
		if hit == nil {
			t.Fatalf("%s: no %s in %v", nodeID, CodeOnErrorContinueNoPrimary, errs)
		}
		if !strings.Contains(hit.Message, `"`+nodeID+`"`) || !strings.HasSuffix(hit.Path, ".onError") {
			t.Fatalf("%s: error does not name the node: %+v", nodeID, *hit)
		}
	}
}
