package workflow

import (
	"strings"
	"testing"
)

func TestCoreNeutralCatalogContracts(t *testing.T) {
	cat := CoreCatalog()
	if !cat.Rules.TriggersAreWorkflowLevel || !cat.Rules.GraphNodesExcludeTriggers {
		t.Fatalf("rules = %+v", cat.Rules)
	}
	for _, trig := range cat.Triggers {
		for _, n := range cat.Nodes {
			if n.Type == trig.Type {
				t.Fatalf("trigger %q must not also be a graph node", trig.Type)
			}
		}
	}
	want := []string{"flow.condition", "flow.delay", "data.set", "data.map", "data.validate", "flow.stop", "flow.fail"}
	for _, typ := range want {
		nt, ok := lookupNode(typ)
		if !ok || nt.Phase != PhaseCore {
			t.Fatalf("missing core node %s", typ)
		}
		if nt.Policy == nil || nt.Bounds == nil || nt.Redaction == nil {
			t.Fatalf("%s missing policy/bounds/redaction: %+v", typ, nt)
		}
		if len(nt.AllowedWith) == 0 && typ != "flow.stop" {
			// flow.stop may omit required with but still has allowedWith
		}
		if typ != "flow.stop" && len(nt.AllowedWith) == 0 {
			t.Fatalf("%s missing allowedWith", typ)
		}
		for _, p := range append(nt.Inputs, nt.Outputs...) {
			if p.Classification == "" || p.MaxBytes == 0 {
				t.Fatalf("%s port %s missing classification/bounds: %+v", typ, p.Name, p)
			}
		}
		if nt.Policy.SideEffects {
			t.Fatalf("%s must not declare provider side effects", typ)
		}
		if !nt.Policy.RetrySafe || !nt.Policy.Idempotent {
			t.Fatalf("%s policy %+v", typ, nt.Policy)
		}
	}
}

func TestCoreNeutralYAMLContracts(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: core-neutral-path
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
          count: 2
        schema:
          type: object
          properties:
            env: {type: string, classification: public}
            count: {type: integer}
          required: [env]
          additionalProperties: false
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          environment: env
          replicas:
            from: count
            convert: integer
    - id: checked
      type: data.validate
      name: Validate
      with:
        schema:
          type: object
          properties:
            environment: {type: string}
            replicas: {type: integer}
          required: [environment]
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: eq
        compare: staging
        path: environment
    - id: pause
      type: flow.delay
      name: Pause
      with:
        duration: PT5M
    - id: done
      type: flow.stop
      name: Done
      with:
        status: success
        message: path complete
    - id: failed
      type: flow.fail
      name: Failed
      with:
        code: gate-rejected
        message: environment not staging
  edges:
    - from: constants.result
      to: mapped.input
    - from: mapped.result
      to: checked.value
    - from: checked.result
      to: gate.value
    - from: gate.true
      to: pause.input
    - from: pause.result
      to: done.input
    - from: gate.false
      to: failed.input
`
	res, errs := ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("valid core graph: %+v", errs)
	}
	if res.Digest == "" || !strings.Contains(res.NormalizedYAML, "type: data.set") {
		t.Fatalf("normalize = %s", res.NormalizedYAML)
	}
	again, errs := ParseAndNormalize([]byte(res.NormalizedYAML))
	if len(errs) > 0 || again.Digest != res.Digest {
		t.Fatalf("round-trip digest %s vs %s: %+v", res.Digest, again.Digest, errs)
	}
}

func TestCoreNeutralRejects(t *testing.T) {
	t.Run("expression mapping", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: expr-map
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          x: "foo||bar"
      inputs:
        input:
          foo: 1
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeExpressionForbidden)
	})

	t.Run("secret data.set", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: secret-set
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          token: ghp_notallowed
`
		_, errs := Parse([]byte(src))
		if !hasCode(errs, CodeSecretForbidden) && !hasCode(errs, CodeClassificationDenied) {
			t.Fatalf("expected secret/classification rejection: %+v", errs)
		}
	})

	t.Run("unknown with key", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: extra-with
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
        sleep: true
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeUnknownField)
	})

	t.Run("oversize delay", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: long-delay
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Wait
      with:
        duration: P30D
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeDurationLimit)
	})

	t.Run("fail secret message", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: fail-secret
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: failed
      type: flow.fail
      name: Failed
      with:
        code: leaked
        message: "-----BEGIN RSA PRIVATE KEY-----"
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeSecretForbidden)
	})

	t.Run("next phase still rejected", func(t *testing.T) {
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
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeUnsupportedNode)
	})

	t.Run("condition missing compare", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: cond
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
      inputs:
        value: ready
`
		_, errs := Parse([]byte(src))
		assertHasCode(t, errs, CodeMissingField)
	})
}

func TestTriggersRemainWorkflowLevel(t *testing.T) {
	src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: trigger-as-node
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: start
      type: manual
      name: Start
`
	_, errs := Parse([]byte(src))
	assertHasCode(t, errs, CodeUnknownNodeType)
}
