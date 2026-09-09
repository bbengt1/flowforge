package workflow

import (
	"strings"
	"testing"
)

const typedManualStartYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: typed-manual
spec:
  triggers:
    - id: manual
      type: manual
      schema:
        type: object
        additionalProperties: false
        required: [env]
        properties:
          env:
            type: string
            enum: [prod, staging]
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`

func TestManualTriggerAcceptsDeclaredSchema(t *testing.T) {
	doc, errs := Parse([]byte(typedManualStartYAML))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	schema := ExtractManualStartSchema(typedManualStartYAML)
	if schema == nil || schema["type"] != "object" {
		t.Fatalf("schema = %#v", schema)
	}
	if doc.Spec.Triggers[0].Type != "manual" {
		t.Fatalf("trigger = %+v", doc.Spec.Triggers[0])
	}
}

func TestManualTriggerRejectsSecurityFields(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: bad-manual
spec:
  triggers:
    - id: manual
      type: manual
      secret: hunter2
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeUnknownField)
	assertHasCode(t, errs, CodeUnsafeReference)
}

func TestValidateManualStartInputBoundsAndSchema(t *testing.T) {
	if errs := ValidateManualStartInput(map[string]any{"env": "prod"}, typedManualStartYAML); len(errs) != 0 {
		t.Fatalf("valid input: %+v", errs)
	}
	errs := ValidateManualStartInput(map[string]any{"env": "dev"}, typedManualStartYAML)
	if len(errs) == 0 {
		t.Fatal("expected enum rejection")
	}
	missing := ValidateManualStartInput(map[string]any{}, typedManualStartYAML)
	assertHasCode(t, missing, CodeMissingField)
	extra := ValidateManualStartInput(map[string]any{"env": "prod", "other": true}, typedManualStartYAML)
	assertHasCode(t, extra, CodeUnknownField)
	huge := map[string]any{"blob": strings.Repeat("x", MaxPortBytes+32)}
	over := ValidateManualStartInput(huge, typedManualStartYAML)
	assertHasCode(t, over, CodeOutputTooLarge)
}

func TestManualStartCatalogDocumentsContract(t *testing.T) {
	cat := CoreCatalog()
	var manual TriggerType
	for _, trig := range cat.Triggers {
		if trig.Type == "manual" {
			manual = trig
		}
	}
	if manual.Start == nil || manual.Bounds == nil || manual.Redaction == nil {
		t.Fatalf("manual catalog incomplete: %+v", manual)
	}
	if manual.Start.Route != "POST /api/v1/workflows/{workflowId}/executions" {
		t.Fatalf("route = %s", manual.Start.Route)
	}
	if !manual.Start.PublishedVersionRequired || !manual.Start.CSRF || !manual.Start.IdempotencyKeyRequired {
		t.Fatalf("start flags = %+v", manual.Start)
	}
	if manual.Start.Permission != "workflow.execute" || manual.Start.MaxInputBytes != MaxPortBytes {
		t.Fatalf("start contract = %+v", manual.Start)
	}
	if manual.Start.CreatedStatus != 201 || manual.Start.ReplayStatus != 200 || manual.Start.ConflictStatus != 409 {
		t.Fatalf("status contract = %+v", manual.Start)
	}
}
