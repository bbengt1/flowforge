package workflow

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func layoutYAML(uiBlock string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
  labels:
    team: platform
` + uiBlock + `spec:
  description: Restart an approved deployment and wait for it to become ready.
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: kubernetes.apply
      name: Restart API
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        fieldManager: flowforge
        wait: ready
        timeoutSeconds: 300
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
  edges: []
  outputs:
    - name: rollout
      from: restart.result
`
}

func validLayoutBlock() string {
	return `  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 120, y: 80 }
`
}

func TestLayoutPersistAndReturn(t *testing.T) {
	src := layoutYAML(validLayoutBlock())
	res, errs := ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("valid layout: %+v", errs)
	}
	if res.Document.UILayout() == nil {
		t.Fatal("expected layout to persist on the document")
	}
	pos, ok := res.Document.UILayout().Nodes["restart"]
	if !ok || pos.X != 120 || pos.Y != 80 {
		t.Fatalf("layout nodes = %+v", res.Document.UILayout().Nodes)
	}
	if res.Summary.UI == nil || res.Summary.UI.Layout == nil {
		t.Fatal("expected summary.ui.layout for Chloe")
	}
	if res.Summary.UI.Layout.Version != UILayoutVersion || res.Summary.UI.Layout.Nodes["restart"].X != 120 {
		t.Fatalf("summary layout = %+v", res.Summary.UI.Layout)
	}
	if !strings.Contains(res.NormalizedYAML, "ui:") || !strings.Contains(res.NormalizedYAML, "layout:") {
		t.Fatalf("normalized YAML missing layout:\n%s", res.NormalizedYAML)
	}
	if !strings.Contains(res.NormalizedYAML, "x: 120") || !strings.Contains(res.NormalizedYAML, "y: 80") {
		t.Fatalf("normalized YAML missing coordinates:\n%s", res.NormalizedYAML)
	}

	again, againErrs := ParseAndNormalize([]byte(res.NormalizedYAML))
	if len(againErrs) > 0 {
		t.Fatalf("round trip: %+v", againErrs)
	}
	if again.Digest != res.Digest {
		t.Fatalf("layout digest unstable: %s vs %s\n%s", res.Digest, again.Digest, again.NormalizedYAML)
	}
	if !reflect.DeepEqual(again.Document.UILayout(), res.Document.UILayout()) {
		t.Fatalf("layout drifted on round trip: %+v vs %+v", again.Document.UILayout(), res.Document.UILayout())
	}
}

func TestOlderDocumentsWithoutLayoutStillWork(t *testing.T) {
	res, errs := ParseAndNormalize([]byte(validRestartYAML))
	if len(errs) > 0 {
		t.Fatalf("%+v", errs)
	}
	if res.Document.UILayout() != nil {
		t.Fatalf("unexpected layout: %+v", res.Document.UILayout())
	}
	if res.Summary.UI != nil {
		t.Fatalf("summary.ui = %+v", res.Summary.UI)
	}
	if strings.Contains(res.NormalizedYAML, "\nui:") {
		t.Fatalf("normalized YAML invented ui:\n%s", res.NormalizedYAML)
	}
}

func TestInvalidLayoutDoesNotInventGraph(t *testing.T) {
	t.Run("ghost node keys are stripped", func(t *testing.T) {
		src := layoutYAML(`  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 10, y: 20 }
        invented: { x: 99, y: 99 }
`)
		res, errs := ParseAndNormalize([]byte(src))
		if len(errs) > 0 {
			t.Fatalf("%+v", errs)
		}
		if _, ok := res.Document.UILayout().Nodes["invented"]; ok {
			t.Fatal("ghost layout key invented a node position")
		}
		if len(res.Document.Spec.Nodes) != 1 || res.Document.Spec.Nodes[0].ID != "restart" {
			t.Fatalf("spec.nodes changed: %+v", res.Document.Spec.Nodes)
		}
		if len(res.Summary.Nodes) != 1 || res.Summary.Nodes[0].ID != "restart" {
			t.Fatalf("summary invented a node: %+v", res.Summary.Nodes)
		}
		if len(res.Summary.Edges) != 0 {
			t.Fatalf("summary invented edges: %+v", res.Summary.Edges)
		}
	})

	t.Run("layout edges types with credentials ports fail closed", func(t *testing.T) {
		for _, extra := range []string{"edges", "types", "with", "credentials", "ports"} {
			src := layoutYAML("  ui:\n    layout:\n      version: 1\n      " + extra + ": {restart: {x: 1, y: 2}}\n      nodes:\n        restart: { x: 1, y: 2 }\n")
			_, errs := Parse([]byte(src))
			if !hasCode(errs, CodeUnknownField) {
				t.Fatalf("%s: want unknown-field, got %+v", extra, errs)
			}
			for _, e := range errs {
				if strings.Contains(strings.ToLower(e.Message), "invent") {
					t.Fatalf("error invented a graph: %+v", e)
				}
			}
		}
	})

	t.Run("non-object layout is treated as absent", func(t *testing.T) {
		src := layoutYAML("  ui:\n    layout: not-an-object\n")
		res, errs := ParseAndNormalize([]byte(src))
		if len(errs) > 0 {
			t.Fatalf("non-object layout should be absent, not invalid: %+v", errs)
		}
		if res.Document.UILayout() != nil {
			t.Fatalf("expected absent layout, got %+v", res.Document.UILayout())
		}
		if len(res.Document.Spec.Nodes) != 1 || res.Document.Spec.Nodes[0].ID != "restart" {
			t.Fatalf("spec changed: %+v", res.Document.Spec.Nodes)
		}
		if strings.Contains(res.NormalizedYAML, "layout:") {
			t.Fatalf("invalid layout was persisted:\n%s", res.NormalizedYAML)
		}
	})

	t.Run("non-finite coordinates are dropped", func(t *testing.T) {
		src := layoutYAML(`  ui:
    layout:
      version: 1
      nodes:
        restart: { x: .nan, y: 80 }
`)
		res, errs := ParseAndNormalize([]byte(src))
		if len(errs) > 0 {
			t.Fatalf("%+v", errs)
		}
		if res.Document.UILayout() == nil {
			t.Fatal("expected layout object to remain")
		}
		if _, ok := res.Document.UILayout().Nodes["restart"]; ok {
			t.Fatalf("non-finite position should be dropped: %+v", res.Document.UILayout().Nodes)
		}
		if len(res.Document.Spec.Nodes) != 1 {
			t.Fatalf("spec invented nodes: %+v", res.Document.Spec.Nodes)
		}
	})

	t.Run("position extra fields fail closed", func(t *testing.T) {
		src := layoutYAML(`  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 1, y: 2, type: kubernetes.apply, with: {command: rm} }
`)
		_, errs := Parse([]byte(src))
		if !hasCode(errs, CodeUnknownField) {
			t.Fatalf("want unknown-field, got %+v", errs)
		}
	})

	t.Run("unknown metadata.ui keys still fail closed", func(t *testing.T) {
		src := layoutYAML("  ui:\n    theme: dark\n    layout:\n      version: 1\n")
		_, errs := Parse([]byte(src))
		if !hasCode(errs, CodeUnknownField) {
			t.Fatalf("want unknown-field, got %+v", errs)
		}
	})
}

func TestExecutionGraphIdenticalWithAndWithoutLayout(t *testing.T) {
	without, withoutErrs := ParseAndNormalize([]byte(layoutYAML("")))
	if len(withoutErrs) > 0 {
		t.Fatalf("without: %+v", withoutErrs)
	}
	with, withErrs := ParseAndNormalize([]byte(layoutYAML(validLayoutBlock())))
	if len(withErrs) > 0 {
		t.Fatalf("with: %+v", withErrs)
	}
	left := without.Document.ExecutionGraph()
	right := with.Document.ExecutionGraph()
	if !reflect.DeepEqual(left, right) {
		t.Fatalf("execution graph drifted\nwithout=%s\nwith=%s", mustJSON(left), mustJSON(right))
	}
	if with.Document.UILayout() == nil {
		t.Fatal("layout should be present on the with-ui document")
	}
	if without.Digest == with.Digest {
		t.Fatal("layout-only change must change the YAML digest")
	}
}

func TestPortTypingIdenticalWithAndWithoutLayout(t *testing.T) {
	base := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: typed-ports
%s
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: left
      type: data.set
      name: Left
      with:
        value:
          a: b
    - id: right
      type: data.map
      name: Right
      with:
        mapping:
          a: b
  edges:
    - from: left.result
      to: right.input
`
	ui := `  ui:
    layout:
      version: 1
      nodes:
        left: { x: 0, y: 0 }
        right: { x: 200, y: 40 }
        ghost: { x: 9, y: 9 }
`
	okWithout, errWithout := Parse([]byte(sprintfLayout(base, "")))
	okWith, errWith := Parse([]byte(sprintfLayout(base, ui)))
	if len(errWithout) > 0 || len(errWith) > 0 {
		t.Fatalf("valid ports: without=%+v with=%+v", errWithout, errWith)
	}
	if !reflect.DeepEqual(okWithout.ExecutionGraph(), okWith.ExecutionGraph()) {
		t.Fatal("valid port graph drifted when layout was present")
	}

	bad := strings.ReplaceAll(base, "left.result", "left.missing")
	_, badWithout := Parse([]byte(sprintfLayout(bad, "")))
	_, badWith := Parse([]byte(sprintfLayout(bad, ui)))
	if !hasCode(badWithout, CodeInvalidPort) || !hasCode(badWith, CodeInvalidPort) {
		t.Fatalf("expected invalid-port both ways: without=%+v with=%+v", badWithout, badWith)
	}
	if codesJSON(badWithout) != codesJSON(badWith) {
		t.Fatalf("port errors drifted\nwithout=%s\nwith=%s", codesJSON(badWithout), codesJSON(badWith))
	}
}

func sprintfLayout(tmpl, ui string) string {
	return strings.Replace(tmpl, "%s", ui, 1)
}

func codesJSON(errs ErrorList) string {
	codes := make([]string, 0, len(errs))
	for _, e := range errs {
		codes = append(codes, e.Code+"|"+e.Path)
	}
	raw, _ := json.Marshal(codes)
	return string(raw)
}

func mustJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return err.Error()
	}
	return string(raw)
}
