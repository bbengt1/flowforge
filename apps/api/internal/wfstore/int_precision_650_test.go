package wfstore

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.3 QA M1, input side: a whole number outside ±2^53 is kept exact
// through the store (step with, step output, the next step's inputs), so
// an expression reads it exactly; passing it straight through as a number
// fails the step closed instead of rounding it.

const intPrecisionYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: int-precision
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
          big: 9007199254740993
          small: 5
          edge: 9007199254740992
    - id: exact
      type: data.map
      name: Exact
      with:
        expr: {expr: '{"s": string(item.big), "d": item.small * 2, "e": item.edge}'}
    - id: pass
      type: data.map
      name: Pass
      with:
        expr: {expr: '{"v": item.big}'}
  edges:
    - from: seed.result
      to: exact.input
    - from: seed.result
      to: pass.input
`

func runIntPrecisionSuite(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) {
	t.Helper()
	src := strings.Replace(intPrecisionYAML, "\n  name: ", "\n  name: p"+strconv.FormatInt(time.Now().UnixNano(), 36)+"-", 1)
	n := mustNormalize(t, src)
	wf, draft, err := store.Create(ctx, scope, CreateInput{NormalizedYAML: n.NormalizedYAML, Digest: n.Digest, Summary: n.Summary})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC()
	claim := func() DispatchResult {
		t.Helper()
		at = at.Add(time.Second)
		got, err := store.ClaimJob(ctx, scope, at, ClaimInput{WorkerID: "w", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	evaluate := func(c DispatchResult) workflow.StepOutcome {
		return workflow.EvaluateStepRun(c.Step.NodeType, c.Step.Input, c.Inputs, nil, RunContextFor(ctx, c.Execution, c.Step))
	}
	seed := claim()
	if seed.Step.NodeID != "seed" {
		t.Fatalf("seed claim %+v", seed.Step)
	}
	if raw, _ := json.Marshal(seed.Step.Input); !strings.Contains(string(raw), "9007199254740993") {
		t.Fatalf("seed with rounded on read: %s", raw)
	}
	out := evaluate(seed)
	if out.Fail {
		t.Fatalf("seed %+v", out)
	}
	if _, err := store.CompleteJob(ctx, scope, at, JobActionInput{JobID: seed.Job.ID, WorkerID: "w", FencingToken: seed.Job.FencingToken, Output: out.Output}); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetStep(ctx, scope, exec.ID, seed.Step.ID)
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(stored.Output); !strings.Contains(string(raw), "9007199254740993") || !strings.Contains(string(raw), `"small":5`) {
		t.Fatalf("seed output rounded in storage: %s", raw)
	}
	for i := 0; i < 2; i++ {
		c := claim()
		if raw, _ := json.Marshal(c.Inputs); !strings.Contains(string(raw), "9007199254740993") {
			t.Fatalf("%s inputs rounded: %s", c.Step.NodeID, raw)
		}
		got := evaluate(c)
		switch c.Step.NodeID {
		case "exact":
			res, _ := got.Output["result"].(map[string]any)
			if got.Fail || res["s"] != "9007199254740993" || res["d"] != int64(10) || res["e"] != int64(1<<53) {
				t.Fatalf("exact %+v", got)
			}
		case "pass":
			if !got.Fail || got.Code != workflow.CodeExpressionRuntime || !strings.Contains(got.Message, `"pass"`) {
				t.Fatalf("pass %+v", got)
			}
			if strings.Contains(got.Message, "900719925474099") {
				t.Fatalf("pass echoes the value: %s", got.Message)
			}
		default:
			t.Fatalf("unexpected claim %s", c.Step.NodeID)
		}
	}
}

func TestMemoryIntPrecision650(t *testing.T) {
	scope, _ := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	runIntPrecisionSuite(t, context.Background(), NewMemory(), scope)
}

func TestPostgresIntPrecision650(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	wsA, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, _ := isolation.Authorize(wsA, userID)
	runIntPrecisionSuite(t, ctx, NewPostgres(app), scope)
}

// unmarshalObject keeps a whole number outside ±2^53 exact and every
// other number a float64, as before.
func TestUnmarshalObjectExactBigInts650(t *testing.T) {
	got := unmarshalObject([]byte(`{"big": 9007199254740993, "neg": -9007199254740993, "edge": 9007199254740992, "small": 5, "f": 1.5, "e": 1e3}`))
	if got["big"] != json.Number("9007199254740993") || got["neg"] != json.Number("-9007199254740993") {
		t.Fatalf("%#v", got)
	}
	if got["edge"] != float64(1<<53) || got["small"] != float64(5) || got["f"] != 1.5 || got["e"] != float64(1000) {
		t.Fatalf("%#v", got)
	}
	c := cloneObject(map[string]any{"v": int64(9007199254740993), "w": int64(7)})
	if c["v"] != json.Number("9007199254740993") || c["w"] != float64(7) {
		t.Fatalf("clone %#v", c)
	}
}
