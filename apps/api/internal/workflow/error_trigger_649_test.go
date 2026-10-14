package workflow

import (
	"strings"
	"testing"
)

const errorTriggerDoc = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: on-error
spec:
  triggers:
    - id: on-error
      type: error%s
  nodes:
    - id: note
      type: data.set
      name: Note
      with:
        value:
          seen: true
`

func TestErrorTrigger649(t *testing.T) {
	doc := func(extra string) string { return strings.Replace(errorTriggerDoc, "%s", extra, 1) }
	cases := []struct {
		name, src, code, path string
	}{
		{"alone is valid", doc(""), "", ""},
		{"fields are refused", doc("\n      with:\n        cron: \"* * * * *\""), CodeUnknownField, "spec.triggers[0].with"},
		{"with another trigger", doc("\n    - id: manual\n      type: manual"), CodeErrorTriggerNotAlone, "spec.triggers[0].type"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, errs := ParseAndNormalize([]byte(c.src))
			if c.code == "" {
				if len(errs) > 0 || res == nil || !HasErrorTrigger(res.Document) || !IsOnlyErrorTriggerYAML(c.src) {
					t.Fatalf("errs = %v", errs)
				}
				return
			}
			for _, e := range errs {
				if e.Code == c.code && e.Path == c.path {
					return
				}
			}
			t.Fatalf("want %s at %s, got %v", c.code, c.path, errs)
		})
	}
	if !IsErrorWorkflow(doc(""), Summary{}) || IsErrorWorkflow(strings.Replace(doc(""), "type: error", "type: manual", 1), Summary{}) {
		t.Fatal("IsErrorWorkflow from YAML")
	}
	if !IsErrorWorkflow("", Summary{Triggers: []TriggerSummary{{ID: "x", Type: TriggerTypeError}}}) {
		t.Fatal("IsErrorWorkflow from summary")
	}
	if !IsErrorWorkflow("spec: [unclosed", Summary{}) {
		t.Fatal("undecodable YAML must fail closed")
	}
}
