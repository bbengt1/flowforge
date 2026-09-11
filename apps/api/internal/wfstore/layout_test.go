package wfstore

import (
	"reflect"
	"strings"
	"testing"

)

func TestPlanNodesIgnoresUILayout(t *testing.T) {
	without := mustNormalize(t, fixtureYAML)
	withSrc := strings.Replace(fixtureYAML, "metadata:\n  name: restart-api-rollout\n", `metadata:
  name: restart-api-rollout
  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 40, y: 80 }
        invented: { x: 1, y: 2 }
`, 1)
	with := mustNormalize(t, withSrc)
	if with.Document.UILayout() == nil {
		t.Fatal("expected layout on the with-ui document")
	}
	left := planNodes(without.NormalizedYAML, without.Summary)
	right := planNodes(with.NormalizedYAML, with.Summary)
	if !reflect.DeepEqual(left, right) {
		t.Fatalf("dispatch plan drifted\nwithout=%+v\nwith=%+v", left, right)
	}
	if len(right) != 1 || right[0].ID != "restart" || right[0].Type != "kubernetes.apply" {
		t.Fatalf("plan invented nodes: %+v", right)
	}
	if _, ok := with.Document.UILayout().Nodes["invented"]; ok {
		t.Fatal("ghost layout key leaked into the document")
	}
}

func TestCompareReportsLayoutOnlyChange(t *testing.T) {
	without := mustNormalize(t, fixtureYAML)
	withSrc := strings.Replace(fixtureYAML, "metadata:\n  name: restart-api-rollout\n", `metadata:
  name: restart-api-rollout
  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 40, y: 80 }
`, 1)
	with := mustNormalize(t, withSrc)
	got := compareDefinitions(
		CompareRef{Kind: RefDraft},
		CompareRef{Kind: RefDraft},
		without.NormalizedYAML,
		with.NormalizedYAML,
		without.Digest,
		with.Digest,
		without.Summary,
		with.Summary,
	)
	if got.Equal || got.DigestMatch {
		t.Fatalf("layout-only change should not be equal: %+v", got)
	}
	found := false
	for _, c := range got.Changes {
		if c.Path == "metadata.ui.layout" && c.Op == "add" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected metadata.ui.layout add, got %+v", got.Changes)
	}
	for _, n := range with.Summary.Nodes {
		if n.ID == "invented" {
			t.Fatal("compare summary invented a node")
		}
	}
}

func TestCompareInvalidLayoutDoesNotGuessGraph(t *testing.T) {
	valid := mustNormalize(t, fixtureYAML)
	invalidSrc := strings.Replace(fixtureYAML, "metadata:\n  name: restart-api-rollout\n", `metadata:
  name: restart-api-rollout
  ui:
    layout: [1, 2, 3]
`, 1)
	invalid := mustNormalize(t, invalidSrc)
	if invalid.Document.UILayout() != nil {
		t.Fatal("invalid layout should be absent")
	}
	if !reflect.DeepEqual(valid.Document.ExecutionGraph(), invalid.Document.ExecutionGraph()) {
		t.Fatal("invalid layout invented an execution graph")
	}
	got := compareDefinitions(
		CompareRef{Kind: RefDraft},
		CompareRef{Kind: RefDraft},
		valid.NormalizedYAML,
		invalid.NormalizedYAML,
		valid.Digest,
		invalid.Digest,
		valid.Summary,
		invalid.Summary,
	)
	if !got.Equal {
		t.Fatalf("absent invalid layout should compare equal to no-ui: %+v", got)
	}
}
