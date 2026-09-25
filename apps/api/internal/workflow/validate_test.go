package workflow

import (
	"strconv"
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
	t.Run("array outputSchema rejected", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: array-out
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
          import json
          print(json.dumps({"status": "ok"}))
        entrypoint: main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
        outputSchema:
          type: array
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeInvalidSchema)
	})
	t.Run("outputSchema without type rejected", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: typeless-out
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
          import json
          print(json.dumps({"status": "ok"}))
        entrypoint: main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
        outputSchema:
          properties:
            status:
              type: string
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeInvalidSchema)
	})
	t.Run("retrySafe without verification", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: retry-script
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
          import json
          print(json.dumps({"status": "ok"}))
        entrypoint: main.py
        runtimeProfileId: 66666666-6666-4666-8666-666666666666
        timeoutSeconds: 30
        retrySafe: true
        retryPolicy:
          maxAttempts: 2
  edges: []
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeInvalidVerification)
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

func TestMetadataNameDisplayTitle(t *testing.T) {
	const base = `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: NAME
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: done
      type: flow.stop
      name: Stop
  edges: []
`
	for _, name := range []string{"Deploy API", "O'Reilly (prod) #2", "restart-api-rollout"} {
		src := strings.Replace(base, "name: NAME", "name: "+strconv.Quote(name), 1)
		res, errs := ParseAndNormalize([]byte(src))
		if len(errs) > 0 {
			t.Fatalf("%q: %+v", name, errs)
		}
		if res.Summary.Name != name {
			t.Fatalf("summary name = %q", res.Summary.Name)
		}
		again, againErrs := ParseAndNormalize([]byte(res.NormalizedYAML))
		if len(againErrs) > 0 {
			t.Fatalf("%q round trip: %+v\n%s", name, againErrs, res.NormalizedYAML)
		}
		if again.Summary.Name != name || again.Digest != res.Digest {
			t.Fatalf("%q did not round-trip: %q\n%s", name, again.Summary.Name, res.NormalizedYAML)
		}
	}

	rejects := []string{
		`name: ""`,
		`name: "   "`,
		`name: "bad\nname"`,
		"name: " + strconv.Quote(strings.Repeat("a", 201)),
	}
	for _, line := range rejects {
		src := strings.Replace(base, "name: NAME", line, 1)
		_, errs := Parse([]byte(src))
		assertDisplayNameError(t, errs, "metadata.name")
	}
}

func TestDisplayNameRejectsFormatAndSeparatorRunes(t *testing.T) {
	const base = `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: NAME
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: done
      type: flow.stop
      name: Stop
  edges: []
`
	cases := []struct {
		name string
		r    rune
	}{
		{name: "zero-width space", r: '\u200B'},
		{name: "right-to-left override", r: '\u202E'},
		{name: "line separator", r: '\u2028'},
		{name: "paragraph separator", r: '\u2029'},
		{name: "byte order mark", r: '\uFEFF'},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			title := "Deploy" + string(tc.r) + "API"
			if ValidDisplayName(title) {
				t.Fatalf("ValidDisplayName(%q) = true", title)
			}
			src := strings.Replace(base, "name: NAME", "name: "+strconv.Quote(title), 1)
			_, errs := Parse([]byte(src))
			assertDisplayNameError(t, errs, "metadata.name")
		})
	}
}

func TestInvalidDisplayNameMessageUsesSentField(t *testing.T) {
	for _, path := range []string{"name", "metadata.name"} {
		err := InvalidDisplayName(path)
		if err.Code != CodeInvalidName || err.Path != path || err.Message != displayNameErrorMessage(path) {
			t.Fatalf("InvalidDisplayName(%q) = %+v", path, err)
		}
	}
	err := InvalidDisplayName("  ")
	if err.Path != "metadata.name" || err.Message != displayNameErrorMessage("metadata.name") || err.Code != CodeInvalidName {
		t.Fatalf("empty path = %+v", err)
	}
}

func assertDisplayNameError(t *testing.T, errs ErrorList, path string) {
	t.Helper()
	assertHasCode(t, errs, CodeInvalidName)
	if len(errs) != 1 || errs[0].Path != path || errs[0].Code != CodeInvalidName || errs[0].Message != displayNameErrorMessage(path) {
		t.Fatalf("errors = %+v, want path %s", errs, path)
	}
}

func displayNameErrorMessage(field string) string {
	return field + " must be 1-200 characters with no surrounding space and no control, format, or line/paragraph separator characters."
}

func TestJoinMarker(t *testing.T) {
	base := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: join-marker
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: seed
      type: data.set
      name: Seed
      with:
        value:
          ready: true
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: exists
    - id: join
      type: kubernetes.apply
      name: Join
      join: any
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: demo
  edges:
    - from: seed.result
      to: gate.value
    - from: gate.true
      to: join.manifests
    - from: gate.false
      to: join.parameters
`
	res, errs := ParseAndNormalize([]byte(base))
	if len(errs) > 0 {
		t.Fatalf("join any: %+v", errs)
	}
	if !strings.Contains(res.NormalizedYAML, "join: any") {
		t.Fatalf("normalized YAML dropped join:\n%s", res.NormalizedYAML)
	}
	if res.Summary.Nodes == nil {
		t.Fatal("missing summary nodes")
	}
	var saw bool
	for _, n := range res.Summary.Nodes {
		if n.ID == "join" {
			saw = n.Join == JoinAny
		}
	}
	if !saw {
		t.Fatalf("summary join = %+v", res.Summary.Nodes)
	}

	_, bad := Parse([]byte(strings.Replace(base, "join: any", "join: or", 1)))
	assertHasCode(t, bad, CodeInvalidType)

	_, one := Parse([]byte(strings.Replace(base, "    - from: gate.false\n      to: join.parameters\n", "", 1)))
	assertHasCode(t, one, CodeInvalidType)
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
