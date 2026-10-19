package wfstore

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.3: execution_steps.eval_clock is set once when an attempt starts
// and read as run.clock; a retry is a new row with a new value. data.map
// expression output goes through checkNodeOutput like any step output.

const evalClockYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: eval-clock
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
          total: 5
          marker: zq7EXPRVALzq7
    - id: shape
      type: data.map
      name: Shape
      with:
        expr: {expr: '{"double": item.total * 2, "at": run.clock, "m": item.marker}'}
  edges:
    - from: seed.result
      to: shape.input
`

func runEvalClockSuite(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) {
	t.Helper()
	src := strings.Replace(evalClockYAML, "\n  name: ", "\n  name: c"+strconv.FormatInt(time.Now().UnixNano(), 36)+"-", 1)
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
	steps, _ := store.ListSteps(ctx, scope, exec.ID)
	for _, s := range steps {
		if s.EvalClock != nil {
			t.Fatalf("eval_clock set before the attempt started: %+v", s)
		}
	}
	claim := func(at time.Time) DispatchResult {
		t.Helper()
		got, err := store.ClaimJob(ctx, scope, at, ClaimInput{WorkerID: "w", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	evaluate := func(c DispatchResult) workflow.StepOutcome {
		return workflow.EvaluateStepRun(c.Step.NodeType, c.Step.Input, c.Inputs, nil, RunContextFor(ctx, c.Execution, c.Step))
	}
	t0 := time.Now().UTC()
	seed := claim(t0)
	if seed.Step.NodeID != "seed" || seed.Step.EvalClock == nil {
		t.Fatalf("seed claim %+v", seed.Step)
	}
	out := evaluate(seed)
	if _, err := store.CompleteJob(ctx, scope, t0, JobActionInput{JobID: seed.Job.ID, WorkerID: "w", FencingToken: seed.Job.FencingToken, Output: out.Output}); err != nil {
		t.Fatal(err)
	}

	t1 := t0.Add(time.Second)
	first := claim(t1)
	if first.Step.NodeID != "shape" || first.Step.EvalClock == nil || !first.Step.EvalClock.Equal(t1.Truncate(time.Microsecond)) && !first.Step.EvalClock.Equal(t1) {
		t.Fatalf("shape claim clock %v want %v", first.Step.EvalClock, t1)
	}
	a := evaluate(first)
	b := evaluate(first)
	if a.Fail || a.Output["result"].(map[string]any)["at"] != b.Output["result"].(map[string]any)["at"] {
		t.Fatalf("not deterministic: %+v %+v", a, b)
	}
	if a.Output["result"].(map[string]any)["double"] != int64(10) {
		t.Fatalf("result %+v", a.Output)
	}
	got, err := store.GetStep(ctx, scope, exec.ID, first.Step.ID)
	if err != nil || got.EvalClock == nil || !got.EvalClock.Equal(*first.Step.EvalClock) {
		t.Fatalf("stored clock %v %v", got.EvalClock, err)
	}

	// data.map output goes through checkNodeOutput: a reserved key is refused.
	forged := map[string]any{"result": a.Output["result"], ItemsSummaryKey: map[string]any{}}
	if _, err := store.CompleteJob(ctx, scope, t1, JobActionInput{JobID: first.Job.ID, WorkerID: "w", FencingToken: first.Job.FencingToken, Output: forged}); !errors.Is(err, ErrReservedOutputKey) {
		t.Fatalf("reserved key: %v", err)
	}

	// Fail this attempt, retry: a new row, no clock until it starts, then
	// a new value.
	if _, err := store.FailJob(ctx, scope, t1, JobActionInput{JobID: first.Job.ID, WorkerID: "w", FencingToken: first.Job.FencingToken, Error: map[string]any{"code": "x", "message": "x"}}); err != nil {
		t.Fatal(err)
	}
	t2 := t1.Add(5 * time.Second)
	rr, err := store.RetryStep(ctx, scope, t2, exec.ID, first.Step.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rr.Step.ID == first.Step.ID || rr.Step.EvalClock != nil {
		t.Fatalf("retry row %+v", rr.Step)
	}
	t3 := t2.Add(time.Second)
	second := claim(t3)
	if second.Step.ID != rr.Step.ID || second.Step.EvalClock == nil || !second.Step.EvalClock.After(*first.Step.EvalClock) {
		t.Fatalf("retry clock %v vs %v", second.Step.EvalClock, first.Step.EvalClock)
	}
	c := evaluate(second)
	if c.Fail || c.Output["result"].(map[string]any)["at"] == a.Output["result"].(map[string]any)["at"] {
		t.Fatalf("retry reused the clock: %+v", c)
	}
	if _, err := store.CompleteJob(ctx, scope, t3, JobActionInput{JobID: second.Job.ID, WorkerID: "w", FencingToken: second.Job.FencingToken, Output: c.Output}); err != nil {
		t.Fatal(err)
	}
	// T5 runtime: expression values never reach audit rows.
	audits, err := store.ListAuditEvents(ctx, scope, AuditListFilter{ResourceID: exec.ID})
	if err != nil || len(audits) == 0 {
		t.Fatalf("audits %d %v", len(audits), err)
	}
	for _, ev := range audits {
		raw, _ := json.Marshal(ev)
		if strings.Contains(string(raw), "zq7EXPRVALzq7") || strings.Contains(string(raw), "item.total") {
			t.Fatalf("audit %s carries an expression value: %s", ev.Action, raw)
		}
	}
	old, _ := store.GetStep(ctx, scope, exec.ID, first.Step.ID)
	if old.EvalClock == nil || !old.EvalClock.Equal(*first.Step.EvalClock) {
		t.Fatal("first attempt's clock changed")
	}
}

func TestMemoryEvalClock650(t *testing.T) {
	scope, _ := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	runEvalClockSuite(t, context.Background(), NewMemory(), scope)
}

func TestPostgresEvalClock650(t *testing.T) {
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
	runEvalClockSuite(t, ctx, NewPostgres(app), scope)

	var typ, nullable string
	if err := admin.QueryRow(ctx, `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'execution_steps' AND column_name = 'eval_clock'`).Scan(&typ, &nullable); err != nil || typ != "timestamp with time zone" || nullable != "YES" {
		t.Fatalf("column %q %q %v", typ, nullable, err)
	}
}
