package approval

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestMemoryResyncFailsUnresolvableRun(t *testing.T) {
	ctx := context.Background()
	workflows := wfstore.NewMemory()
	approvals := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC)
	ver := publishMemoryWorkflow(t, ctx, workflows, scope, expiredDownstreamDefinition)
	exec, err := workflows.StartExecution(ctx, scope, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflows.StartExecution(ctx, scope, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID, MaxOpen: 1}); !errors.Is(err, wfstore.ErrConcurrency) {
		t.Fatalf("slot before close = %v", err)
	}
	claimed, err := workflows.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %+v %v", claimed.Step.NodeID, err)
	}
	if _, err := workflows.WaitJob(ctx, scope, now, wfstore.WaitJobInput{
		JobID: claimed.Job.ID, AvailableAt: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	approvals.SetUnresolvableRun(workflows.SettleUnresolvableGate)
	rec, err := approvals.Create(ctx, scope, CreateInput{
		WorkflowID: ver.WorkflowID, WorkflowVersionID: "88888888-8888-4888-8888-888888888888", WorkflowDigest: ver.Digest,
		ExecutionID: exec.ID, RequestedBy: "77777777-7777-4777-8777-777777777777",
		Requirement: policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	stats := approvals.ResyncPending(ctx, workflows, nil, now)
	if stats.Closed != 1 || stats.Corrected != 0 || stats.Failed != 0 {
		t.Fatalf("stats = %+v", stats)
	}
	closed, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || closed.Status != StatusCanceled || closed.CloseReason != ReasonRequirementUnresolvable || closed.DecidedBy != "" {
		t.Fatalf("closed = %+v %v", closed, err)
	}
	got, err := workflows.GetExecutionByID(ctx, scope, exec.ID)
	if err != nil || got.Status != wfstore.ExecutionFailed {
		t.Fatalf("run = %+v %v", got.Status, err)
	}
	gateStep, gateJob := memoryStepJob(t, ctx, workflows, scope, exec.ID, "gate")
	if gateStep.Status != wfstore.ExecutionFailed || gateJob.Status != wfstore.JobFailed {
		t.Fatalf("gate step=%s job=%s", gateStep.Status, gateJob.Status)
	}
	if code, _ := gateStep.Error["code"].(string); code != wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("gate error = %+v", gateStep.Error)
	}
	if port, _ := gateStep.Output["port"].(string); port == "expired" {
		t.Fatalf("gate took expired port: %+v", gateStep.Output)
	}
	lateStep, lateJob := memoryStepJob(t, ctx, workflows, scope, exec.ID, "late")
	if lateStep.Status != wfstore.ExecutionCanceled || lateJob.Status != wfstore.JobCanceled || lateStep.StartedAt != nil {
		t.Fatalf("late step=%s job=%s started=%v", lateStep.Status, lateJob.Status, lateStep.StartedAt)
	}
	if _, err := workflows.StartExecution(ctx, scope, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID, MaxOpen: 1}); err != nil {
		t.Fatalf("slot after close = %v", err)
	}
	again := approvals.ResyncPending(ctx, workflows, nil, now.Add(time.Minute))
	if again.Closed != 0 || again.Corrected != 0 || again.Failed != 0 {
		t.Fatalf("second = %+v", again)
	}
	still, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || !still.UpdatedAt.Equal(closed.UpdatedAt) {
		t.Fatalf("second pass changed %+v", still)
	}
	stillLate, _ := memoryStepJob(t, ctx, workflows, scope, exec.ID, "late")
	if stillLate.Status != wfstore.ExecutionCanceled {
		t.Fatalf("second pass released late %s", stillLate.Status)
	}
}

func TestMemoryResyncLeavesPendingWhenSettleFails(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	store.SetUnresolvableRun(func(context.Context, isolation.Scope, string, string, string, time.Time) error {
		return errors.New("settle")
	})
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: "88888888-8888-4888-8888-888888888888",
		WorkflowDigest: "sha256:" + "abababababababababababababababababababababababababababababababab",
		RequestedBy:    "77777777-7777-4777-8777-777777777777",
		Requirement:    policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	stats := store.ResyncPending(ctx, staticVersion{err: wfstore.ErrNotFound}, nil, now)
	if stats.Closed != 0 || stats.Failed != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusPending || got.CloseReason != "" || got.DecidedBy != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func publishMemoryWorkflow(t *testing.T, ctx context.Context, store *wfstore.Memory, scope isolation.Scope, src string) wfstore.Version {
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
	return ver
}

func memoryStepJob(t *testing.T, ctx context.Context, store *wfstore.Memory, scope isolation.Scope, executionID, node string) (wfstore.ExecutionStep, wfstore.ExecutionJob) {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var step wfstore.ExecutionStep
	for _, item := range steps {
		if item.NodeID == node && item.Attempt >= step.Attempt {
			step = item
		}
	}
	if step.ID == "" {
		t.Fatalf("missing step %s", node)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range jobs {
		if job.ExecutionStepID == step.ID {
			return step, job
		}
	}
	t.Fatalf("missing job %s", node)
	return step, wfstore.ExecutionJob{}
}

const expiredDownstreamDefinition = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: expired-downstream
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
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
