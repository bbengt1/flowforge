package workflow

import (
	"strings"
	"testing"
)

func TestWebhookTriggerAcceptsDeclaredSchema(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: typed-webhook
spec:
  triggers:
    - id: hook
      type: webhook
      inputSchema:
        type: object
        additionalProperties: false
        required: [env]
        properties:
          env:
            type: string
            enum: [prod, staging]
      contentType: application/json
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
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	schema := ExtractWebhookStartSchema(src)
	if schema == nil || schema["type"] != "object" {
		t.Fatalf("schema = %#v", schema)
	}
	if ExtractWebhookContentType(src) != "application/json" {
		t.Fatalf("content type = %q", ExtractWebhookContentType(src))
	}
}

func TestWebhookTriggerRejectsSecretFields(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: bad-webhook
spec:
  triggers:
    - id: hook
      type: webhook
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

func TestValidateWebhookStartInputBoundsAndSchema(t *testing.T) {
	src := typedManualStartYAML
	src = strings.ReplaceAll(src, "type: manual", "type: webhook")
	src = strings.ReplaceAll(src, "id: manual", "id: hook")
	if errs := ValidateWebhookStartInput(map[string]any{"env": "prod"}, src); len(errs) != 0 {
		t.Fatalf("valid: %+v", errs)
	}
	bad := ValidateWebhookStartInput(map[string]any{"env": "dev"}, src)
	if len(bad) == 0 {
		t.Fatal("expected enum rejection")
	}
	over := ValidateWebhookStartInput(map[string]any{"blob": strings.Repeat("x", MaxPortBytes+32)}, src)
	assertHasCode(t, over, CodeOutputTooLarge)
}

func TestWebhookCatalogDocumentsContract(t *testing.T) {
	cat := CoreCatalog()
	var hook TriggerType
	for _, trig := range cat.Triggers {
		if trig.Type == "webhook" {
			hook = trig
		}
	}
	if hook.Ingress == nil || hook.Admin == nil || hook.Bounds == nil {
		t.Fatalf("incomplete: %+v", hook)
	}
	if hook.Ingress.Route != "POST /api/v1/hooks/{publicId}" || hook.Ingress.Session || hook.Ingress.CSRF {
		t.Fatalf("ingress = %+v", hook.Ingress)
	}
	if !hook.Admin.SecretNeverReturned || hook.Admin.Permission != "workflow.edit" {
		t.Fatalf("admin = %+v", hook.Admin)
	}
}
