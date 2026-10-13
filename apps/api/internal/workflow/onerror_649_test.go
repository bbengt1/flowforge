package workflow

import (
	"strings"
	"testing"
)

// #649 S1: onError publish validation. Engine behavior is unchanged.

func onErrorDoc(leftExtra, rightExtra, edges, trigExtra string) string {
	return `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: on-error
spec:
  triggers:
    - id: manual
      type: manual
` + trigExtra + `
  nodes:
    - id: left
      type: data.map
      name: Left
` + leftExtra + `
      inputs:
        input:
          b: x
      with:
        mapping:
          a: b
    - id: right
      type: data.map
      name: Right
` + rightExtra + `
      with:
        mapping:
          a: b
  edges:
` + edges
}

const mainEdge = "    - from: left.result\n      to: right.input\n"
const errorEdge = "    - from: left.error\n      to: right.input\n"

func codes(errs ErrorList) []string {
	var out []string
	for _, e := range errs {
		out = append(out, e.Code)
	}
	return out
}

func TestOnError649Valid(t *testing.T) {
	cases := map[string]string{
		"omitted":     onErrorDoc("", "", mainEdge, ""),
		"stop":        onErrorDoc("      onError: stop", "", mainEdge, ""),
		"continue":    onErrorDoc("      onError: continue", "", mainEdge, ""),
		"errorOutput": onErrorDoc("      onError: errorOutput", "", errorEdge, ""),
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			res, errs := ParseAndNormalize([]byte(src))
			if len(errs) > 0 {
				t.Fatalf("unexpected errors: %+v", errs)
			}
			left := res.Document.Spec.Nodes[0]
			if left.ID != "left" {
				for _, n := range res.Document.Spec.Nodes {
					if n.ID == "left" {
						left = n
					}
				}
			}
			want := map[string]string{"omitted": "", "stop": "stop", "continue": "continue", "errorOutput": "errorOutput"}[name]
			if left.OnError != want {
				t.Fatalf("OnError=%q want %q", left.OnError, want)
			}
			if want != "" && !strings.Contains(res.NormalizedYAML, "onError: "+want) {
				t.Fatalf("normalized YAML lost onError:\n%s", res.NormalizedYAML)
			}
			if want == "" && strings.Contains(res.NormalizedYAML, "onError") {
				t.Fatalf("normalized YAML gained onError")
			}
			// Round-trip stays stable.
			res2, errs2 := ParseAndNormalize([]byte(res.NormalizedYAML))
			if len(errs2) > 0 || res2.Digest != res.Digest {
				t.Fatalf("round trip changed: %v", codes(errs2))
			}
		})
	}
}

func TestOnError649Rejects(t *testing.T) {
	cases := []struct {
		name, src, code, path string
	}{
		{"unknown value", onErrorDoc("      onError: retry", "", mainEdge, ""), CodeInvalidOnError, "spec.nodes[0].onError"},
		{"case sensitive", onErrorDoc("      onError: ErrorOutput", "", mainEdge, ""), CodeInvalidOnError, "spec.nodes[0].onError"},
		{"empty string", onErrorDoc(`      onError: ""`, "", mainEdge, ""), CodeInvalidOnError, "spec.nodes[0].onError"},
		{"errorOutput without error edge", onErrorDoc("      onError: errorOutput", "", mainEdge, ""), CodeErrorEdgeMissing, "spec.nodes[0].onError"},
		{"error edge without onError", onErrorDoc("", "", errorEdge, ""), CodeErrorEdgeWithoutHandler, "spec.edges[0].from"},
		{"error edge with continue", onErrorDoc("      onError: continue", "", errorEdge, ""), CodeErrorEdgeWithoutHandler, "spec.edges[0].from"},
		{"error edge with stop", onErrorDoc("      onError: stop", "", errorEdge, ""), CodeErrorEdgeWithoutHandler, "spec.edges[0].from"},
		{"onError on trigger", onErrorDoc("", "", mainEdge, "      onError: continue"), CodeOnErrorNotAllowed, "spec.triggers[0].onError"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, errs := Parse([]byte(tc.src))
			found := false
			for _, e := range errs {
				if e.Code == tc.code && e.Path == tc.path {
					found = true
					if strings.TrimSpace(e.Message) == "" {
						t.Fatalf("empty message")
					}
				}
			}
			if !found {
				t.Fatalf("want %s at %s, got %+v", tc.code, tc.path, errs)
			}
		})
	}
}

func TestOnError649NonScalar(t *testing.T) {
	_, errs := Parse([]byte(onErrorDoc("      onError: [continue]", "", mainEdge, "")))
	if len(errs) == 0 {
		t.Fatal("expected error for non-scalar onError")
	}
}

func TestOnError649ErrorEdgeCycle(t *testing.T) {
	src := onErrorDoc("      onError: errorOutput", "", errorEdge+"    - from: right.result\n      to: left.input\n", "")
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeCycle)
}

func TestOnError649Approval(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: approval-on-error
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      onError: continue
      with:
        approverRole: admin
`
	_, errs := Parse([]byte(src))
	found := false
	for _, e := range errs {
		if e.Code == CodeOnErrorNotAllowed && e.Path == "spec.nodes[0].onError" {
			found = true
		}
	}
	if !found {
		t.Fatalf("want on-error-not-allowed, got %+v", errs)
	}
}
