package workflow

import (
	"strings"
	"testing"
)

const validRestartYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
  labels:
    team: platform
spec:
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

const validComposedYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: validate-restart-and-notify
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: precheck
      type: ssh.run
      name: Check API host
      with:
        sshTargetId: 22222222-2222-4222-8222-222222222222
        commandProfileId: 44444444-4444-4444-8444-444444444444
        timeoutSeconds: 30
    - id: restart
      type: kubernetes.apply
      name: Restart API deployment
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
    - id: summarize
      type: script.python
      name: Build change summary
      with:
        source: |
          import json
          print(json.dumps({"summary": "restart complete"}))
        entrypoint: main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
    - id: notify
      type: notification.webhook
      name: Notify operations
      with:
        connectionId: 55555555-5555-4555-8555-555555555555
  edges:
    - from: precheck.result
      to: restart.parameters
    - from: restart.result
      to: summarize.input
    - from: summarize.result
      to: notify.payload
`

func TestParseValidDefinitions(t *testing.T) {
	for _, src := range []string{validRestartYAML, validComposedYAML} {
		doc, errs := Parse([]byte(src))
		if len(errs) > 0 {
			t.Fatalf("valid YAML rejected: %+v", errs)
		}
		if doc.Metadata.Name == "" || len(doc.Spec.Nodes) == 0 {
			t.Fatalf("incomplete document: %+v", doc)
		}
	}
}

func TestRejectMalformedYAML(t *testing.T) {
	_, errs := Parse([]byte("apiVersion: [unterminated\n"))
	assertHasCode(t, errs, CodeMalformedYAML)
}

func TestRejectUnsupportedTagsAndAliases(t *testing.T) {
	t.Run("custom tag", func(t *testing.T) {
		src := strings.Replace(validRestartYAML, "name: restart-api-rollout", "name: !custom restart-api-rollout", 1)
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeUnsupportedTag)
	})
	t.Run("alias", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: aliased
  labels: &labs
    team: platform
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Wait
      with:
        duration: PT5M
        extra: *labs
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeAliasForbidden)
	})
	t.Run("merge key", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: merged
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Wait
      with:
        <<: {duration: PT5M}
  edges: []
`
		_, errs := Parse([]byte(src))
		if !hasCode(errs, CodeUnsupportedTag) && !hasCode(errs, CodeUnknownField) && !hasCode(errs, CodeMalformedYAML) {
			t.Fatalf("merge key accepted: %+v", errs)
		}
	})
}

func TestRejectTemplates(t *testing.T) {
	src := strings.Replace(validRestartYAML, "namespace: cp-ops-nprd", "namespace: \"{{ .Values.ns }}\"", 1)
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeTemplateForbidden)
}

func TestRejectDuplicateKeysAndMultipleDocuments(t *testing.T) {
	t.Run("duplicate key", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: dup
  name: other
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Wait
      with:
        duration: PT5M
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeDuplicateKey)
	})
	t.Run("multiple documents", func(t *testing.T) {
		src := validRestartYAML + "---\napiVersion: flowforge/v1\n"
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeMultipleDocuments)
	})
}

func TestRejectUnknownFields(t *testing.T) {
	src := strings.Replace(validRestartYAML, "kind: Workflow", "kind: Workflow\nextra: true", 1)
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeUnknownField)
}

func TestParserLimits(t *testing.T) {
	big := strings.Repeat("x", MaxDocumentBytes+1)
	_, errs := Parse([]byte(big))
	assertHasCode(t, errs, CodeDocumentTooLarge)
}

func assertHasCode(t *testing.T, errs ErrorList, code string) {
	t.Helper()
	if !hasCode(errs, code) {
		t.Fatalf("want code %s, got %+v", code, errs)
	}
}

func hasCode(errs ErrorList, code string) bool {
	for _, e := range errs {
		if e.Code == code {
			return true
		}
	}
	return false
}
