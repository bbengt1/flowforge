package wfstore

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.4: data.merge, data.filter, data.sort and flow.switch run end to
// end on both stores. data.filter and data.merge output goes through
// checkNodeOutput like any step output (Gracie check 3).

const flowDataYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: flow-data
spec:
  triggers:
    - {id: manual, type: manual}
  nodes:
    - {id: a, type: data.set, name: A, with: {value: {items: [{id: 3, n: 7}, {id: 1, n: 1}]}}}
    - {id: b, type: data.set, name: B, with: {value: {items: [{id: 2, n: 9}, {id: 4, n: 9}]}}}
    - {id: merge, type: data.merge, name: Merge, join: all, with: {mode: append}}
    - {id: keep, type: data.filter, name: Keep, with: {expr: {expr: 'item.n > 2'}}}
    - {id: order, type: data.sort, name: Order, with: {key: n, order: desc}}
    - {id: route, type: flow.switch, name: Route, with: {path: items, cases: [{name: none, op: eq, compare: []}], default: some}}
    - {id: some, type: flow.stop, name: Some, with: {status: success}}
    - {id: none, type: flow.stop, name: None, with: {status: success}}
    - {id: gone, type: flow.stop, name: Gone, with: {status: success}}
  edges:
    - {from: a.result, to: merge.left}
    - {from: b.result, to: merge.right}
    - {from: merge.result, to: keep.input}
    - {from: keep.kept, to: order.input}
    - {from: keep.dropped, to: gone.input}
    - {from: order.result, to: route.value}
    - {from: route.some, to: some.input}
    - {from: route.none, to: none.input}
`

func runFlowDataSuite(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) {
	t.Helper()
	src := strings.Replace(flowDataYAML, "\n  name: ", "\n  name: d"+strconv.FormatInt(time.Now().UnixNano(), 36)+"-", 1)
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
	now := time.Now().UTC()
	outputs := map[string]map[string]any{}
	for i := 0; i < 20; i++ {
		now = now.Add(time.Second)
		c, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "w", Lease: time.Minute})
		if errors.Is(err, ErrEmptyClaim) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		o := workflow.EvaluateStepRun(c.Step.NodeType, c.Step.Input, c.Inputs, nil, RunContextFor(ctx, c.Execution, c.Step), "")
		if o.Fail {
			t.Fatalf("%s failed: %+v", c.Step.NodeID, o)
		}
		if c.Step.NodeType == "data.filter" || c.Step.NodeType == "data.merge" {
			forged := map[string]any{ItemsSummaryKey: map[string]any{}}
			for k, v := range o.Output {
				forged[k] = v
			}
			if _, err := store.CompleteJob(ctx, scope, now, JobActionInput{JobID: c.Job.ID, WorkerID: "w", FencingToken: c.Job.FencingToken, Output: forged}); !errors.Is(err, ErrReservedOutputKey) {
				t.Fatalf("%s: reserved key accepted: %v", c.Step.NodeID, err)
			}
		}
		if _, err := store.CompleteJob(ctx, scope, now, JobActionInput{JobID: c.Job.ID, WorkerID: "w", FencingToken: c.Job.FencingToken, Output: o.Output}); err != nil {
			t.Fatalf("%s: %v", c.Step.NodeID, err)
		}
		outputs[c.Step.NodeID] = o.Output
	}
	got, err := store.GetExecution(ctx, scope, wf.ID, exec.ID)
	if err != nil || got.Status != "succeeded" {
		t.Fatalf("run %+v %v", got.Status, err)
	}
	steps, _ := store.ListSteps(ctx, scope, exec.ID)
	status := map[string]string{}
	for _, s := range steps {
		status[s.NodeID] = string(s.Status)
	}
	for id, want := range map[string]string{"merge": "succeeded", "keep": "succeeded", "order": "succeeded", "route": "succeeded", "some": "succeeded", "gone": "succeeded", "none": "skipped"} {
		if status[id] != want {
			t.Fatalf("%s = %s want %s (%v)", id, status[id], want, status)
		}
	}
	sorted := outputs["order"]["result"].(map[string]any)["items"].([]any)
	var ids []string
	for _, it := range sorted {
		ids = append(ids, toStr(it.(map[string]any)["id"]))
	}
	if strings.Join(ids, ",") != "2,4,3" {
		t.Fatalf("sorted ids %v", ids)
	}
}

func toStr(v any) string {
	switch n := v.(type) {
	case float64:
		return strconv.FormatFloat(n, 'f', -1, 64)
	case int:
		return strconv.Itoa(n)
	case int64:
		return strconv.FormatInt(n, 10)
	}
	return "?"
}

func TestMemoryFlowDataNodes650(t *testing.T) {
	scope, _ := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	runFlowDataSuite(t, context.Background(), NewMemory(), scope)
}

func TestPostgresFlowDataNodes650(t *testing.T) {
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
	runFlowDataSuite(t, ctx, NewPostgres(app), scope)
}
