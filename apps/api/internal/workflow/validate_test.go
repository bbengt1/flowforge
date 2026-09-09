package workflow

import (
	"strings"
	"testing"
)

func TestRejectCyclesAndDisconnectedNodes(t *testing.T) {
	t.Run("cycle", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: cyclic
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: left
      type: data.map
      name: Left
      with:
        mapping:
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
    - from: right.result
      to: left.input
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeCycle)
		found := false
		for _, e := range errs {
			if e.Code == CodeCycle && strings.Contains(e.Message, "left") && strings.Contains(e.Message, "right") && !strings.Contains(e.Message, "left -> left") {
				found = true
			}
		}
		if !found {
			t.Fatalf("cycle message not actionable: %+v", errs)
		}
	})

	t.Run("disconnected", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: disconnected
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
    - id: other
      type: flow.stop
      name: Stop
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeDisconnectedNode)
	})
}

func TestRejectInvalidPorts(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: bad-ports
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: precheck
      type: ssh.run
      name: Check
      with:
        sshTargetId: 22222222-2222-4222-8222-222222222222
        commandProfileId: 44444444-4444-4444-8444-444444444444
    - id: notify
      type: notification.webhook
      name: Notify
      with:
        connectionId: 55555555-5555-4555-8555-555555555555
  edges:
    - from: precheck.stdout
      to: notify.payload
`
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeIncompatiblePorts)
}

func TestRejectUnknownAndUnsupportedNodes(t *testing.T) {
	t.Run("unknown", func(t *testing.T) {
		src := nodeYAML("invented.action")
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeUnknownNodeType)
	})
	t.Run("next-phase", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: next-phase
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: child
      type: workflow.call
      name: Call child
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeUnsupportedNode)
	})
}

func TestRejectUnsafeReferences(t *testing.T) {
	t.Run("raw ssh command", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: raw-ssh
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: clear-cache
      type: ssh.run
      name: Clear cache
      with:
        sshTargetId: 22222222-2222-4222-8222-222222222222
        commandProfileId: 33333333-3333-4333-8333-333333333333
        command: rm -rf /
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeUnsafeReference)
	})

	t.Run("non-uuid target", func(t *testing.T) {
		src := strings.Replace(validRestartYAML, "11111111-1111-4111-8111-111111111111", "prod-cluster", 1)
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeInvalidUUID)
	})

	t.Run("secret field", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: leak
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
        password: hunter2
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeUnsafeReference)
	})

	t.Run("kubernetes get requires kind", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: get-cm
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: read
      type: kubernetes.get
      name: Get config
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeMissingField)
	})

	t.Run("rolloutStatus kind must be observable", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: watch-cm
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: watch
      type: kubernetes.rolloutStatus
      name: Watch config
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        kind: ConfigMap
        name: cfg
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeInvalidWith)
	})

	t.Run("secret manifest", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: secret-apply
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: apply
      type: kubernetes.apply
      name: Apply secret
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        manifests: |
          apiVersion: v1
          kind: Secret
          metadata:
            name: leaked
          stringData:
            token: nope
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeSecretForbidden)
	})
}

func TestRequiredInputMustBeWired(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: missing-input
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: eq
        compare: ready
  edges: []
`
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeRequiredInput)
}

func TestUnsupportedTrigger(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: event-trigger
spec:
  triggers:
    - id: bus
      type: event
  nodes:
    - id: pause
      type: flow.delay
      name: Wait
      with:
        duration: PT5M
  edges: []
`
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeUnsupportedTrigger)
}

func TestScriptSourceAndEntrypointRejected(t *testing.T) {
	t.Run("secret in source", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: secret-script
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: script.python
      name: Run
      with:
        source: |
          token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        entrypoint: main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeSecretForbidden)
	})
	t.Run("path entrypoint", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: bad-entry
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: script.python
      name: Run
      with:
        source: |
          print("ok")
        entrypoint: ../main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeInvalidEntrypoint)
	})
}

func nodeYAML(typ string) string {
	return `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: one-node
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: only
      type: ` + typ + `
      name: Only
  edges: []
`
}
