package runner

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPollOnceContinuesAfterTransientGate(t *testing.T) {
	ctx := context.Background()
	store := wfstore.NewMemory()
	stuckWS := "11111111-1111-4111-8111-111111111111"
	stuckActor := "22222222-2222-4222-8222-222222222222"
	readyWS := "33333333-3333-4333-8333-333333333333"
	readyActor := "44444444-4444-4444-8444-444444444444"
	stuckScope, err := isolation.Authorize(stuckWS, stuckActor)
	if err != nil {
		t.Fatal(err)
	}
	readyScope, err := isolation.Authorize(readyWS, readyActor)
	if err != nil {
		t.Fatal(err)
	}
	stuckExec := publishMemoryRun(t, ctx, store, stuckScope, gateYAML("stuck-gate"))
	readyExec := publishMemoryRun(t, ctx, store, readyScope, stopYAML("ready-stop"))
	versions := &denyWorkspace{Memory: store, workspaceID: stuckWS}
	var buf bytes.Buffer
	queue := &StoreQueue{
		Workflows: versions,
		JobKey:    wfstore.NewJobBindingKey(),
		WorkerID:  "production-runner",
		Lease:     time.Minute,
		Fixed: []Workspace{
			{ID: stuckWS, ActorID: stuckActor},
			{ID: readyWS, ActorID: readyActor},
		},
	}
	loop := NewRunner(queue, &Dispatcher{}, Config{
		WorkerID: "production-runner",
		Log:      slog.New(slog.NewTextHandler(&buf, nil)),
	})
	n, err := loop.PollOnce(ctx)
	if err != nil || n != 2 {
		t.Fatalf("poll n=%d err=%v log=%s", n, err, buf.String())
	}
	stuckJob := memoryJob(t, ctx, store, stuckScope, stuckExec.ID)
	if stuckJob.Status != wfstore.JobQueued {
		t.Fatalf("stuck gate = %+v", stuckJob)
	}
	readyJob := memoryJob(t, ctx, store, readyScope, readyExec.ID)
	if readyJob.Status != wfstore.JobSucceeded {
		t.Fatalf("ready job = %+v", readyJob)
	}
	logText := buf.String()
	for _, want := range []string{stuckWS, stuckJob.ID, "approval_requirement_unavailable"} {
		if !bytes.Contains(buf.Bytes(), []byte(want)) {
			t.Fatalf("log missing %s: %s", want, logText)
		}
	}
}

func TestTransientGatePastDeadlineFailsUnresolvable(t *testing.T) {
	ctx := context.Background()
	store := wfstore.NewMemory()
	ws := "11111111-1111-4111-8111-111111111111"
	actor := "22222222-2222-4222-8222-222222222222"
	scope, err := isolation.Authorize(ws, actor)
	if err != nil {
		t.Fatal(err)
	}
	exec := publishMemoryRun(t, ctx, store, scope, expiredDownstreamRunnerYAML())
	job := memoryNodeJob(t, ctx, store, scope, exec.ID, "gate")
	later := job.CreatedAt.Add(2 * time.Hour)
	versions := &denyWorkspace{Memory: store, workspaceID: ws}
	queue := &StoreQueue{
		Workflows: versions,
		JobKey:    wfstore.NewJobBindingKey(),
		WorkerID:  "production-runner",
		Lease:     time.Minute,
		Now:       func() time.Time { return later },
		Fixed:     []Workspace{{ID: ws, ActorID: actor}},
	}
	loop := NewRunner(queue, &Dispatcher{}, Config{
		WorkerID: "production-runner",
		Log:      slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
	})
	loop.now = func() time.Time { return later }
	if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
		t.Fatalf("poll n=%d err=%v", n, err)
	}
	failed := memoryNodeJob(t, ctx, store, scope, exec.ID, "gate")
	if failed.Status != wfstore.JobFailed || failed.Attempt != job.Attempt {
		t.Fatalf("gate job = %+v", failed)
	}
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == "gate" && (step.Status != wfstore.ExecutionFailed || step.Error["code"] != wfstore.ReasonRequirementUnresolvable) {
			t.Fatalf("gate step = %+v", step)
		}
		if port, _ := step.Output["port"].(string); port == "expired" {
			t.Fatalf("%s took expired", step.NodeID)
		}
		if step.NodeID == "late" && step.Status == wfstore.ExecutionSucceeded {
			t.Fatal("late ran")
		}
	}
	got, err := store.GetExecutionByID(ctx, scope, exec.ID)
	if err != nil || got.Status != wfstore.ExecutionFailed {
		t.Fatalf("run = %+v %v", got, err)
	}
}

type denyWorkspace struct {
	*wfstore.Memory
	workspaceID string
}

func (d denyWorkspace) GetVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (wfstore.Version, error) {
	if scope.WorkspaceID() == d.workspaceID {
		return wfstore.Version{}, errors.Join(wfstore.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
	}
	return d.Memory.GetVersion(ctx, scope, workflowID, versionID)
}

func publishMemoryRun(t *testing.T, ctx context.Context, store *wfstore.Memory, scope isolation.Scope, src string) wfstore.Execution {
	t.Helper()
	parsed, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := store.Create(ctx, scope, wfstore.CreateInput{
		NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return exec
}

func memoryJob(t *testing.T, ctx context.Context, store *wfstore.Memory, scope isolation.Scope, executionID string) wfstore.ExecutionJob {
	t.Helper()
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %+v %v", jobs, err)
	}
	return jobs[0]
}

func memoryNodeJob(t *testing.T, ctx context.Context, store *wfstore.Memory, scope isolation.Scope, executionID, nodeID string) wfstore.ExecutionJob {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var stepID string
	for _, step := range steps {
		if step.NodeID == nodeID {
			stepID = step.ID
		}
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range jobs {
		if job.ExecutionStepID == stepID {
			return job
		}
	}
	t.Fatalf("missing %s", nodeID)
	return wfstore.ExecutionJob{}
}

func gateYAML(name string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ` + name + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1H
  edges: []
`
}

func stopYAML(name string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ` + name + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: done
      type: flow.stop
      name: Done
      with:
        status: success
  edges: []
`
}

func expiredDownstreamRunnerYAML() string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: runner-deadline
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1H
    - id: late
      type: flow.stop
      name: Late
      with:
        status: success
  edges:
    - from: gate.expired
      to: late.input
`
}
