package approvalhttp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestTransientReleaseFailureRequeuesOnLeaseExpiry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
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
	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, fmt.Sprintf("rq-%d", suffix%100000000), "RQ")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", fmt.Sprintf("rqu-%d", suffix%100000000), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, fmt.Sprintf("rqd-%d", suffix%100000000), "Desk", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: requeue-transient-` + fmt.Sprintf("%d", suffix%100000000) + `
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
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	frozen := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, frozen, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Step.NodeID != "gate" {
		t.Fatalf("claimed %s", claimed.Step.NodeID)
	}
	attempt := claimed.Job.Attempt
	srv := &core.Server{Workflows: transientNoRelease{Postgres: store}, Clock: func() time.Time { return frozen }}
	if _, err := ParkApprovalClaim(srv, ctx, scope, claimed); !errors.Is(err, approval.ErrBindingTransient) {
		t.Fatalf("park = %v", err)
	}
	assertGateClaimed(t, ctx, store, scope, exec.ID, attempt)
	if _, err := store.RecoverExpiredLeases(ctx, scope, frozen.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	assertGateRequeued(t, ctx, store, scope, exec.ID, attempt)
	if _, err := store.RecoverExpiredLeases(ctx, scope, frozen.Add(3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	assertGateRequeued(t, ctx, store, scope, exec.ID, attempt)
}

// transientNoRelease fails the requirement rebuild and then fails the
// release, so the claim stays held until lease recovery.
type transientNoRelease struct {
	*wfstore.Postgres
}

func (transientNoRelease) GetVersion(context.Context, isolation.Scope, string, string) (wfstore.Version, error) {
	return wfstore.Version{}, context.DeadlineExceeded
}

func (transientNoRelease) ReleaseJob(context.Context, isolation.Scope, time.Time, wfstore.JobActionInput) (wfstore.DispatchResult, error) {
	return wfstore.DispatchResult{}, errors.New("release failed")
}

func assertGateClaimed(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string, attempt int) {
	t.Helper()
	pair := gateAndLate(t, ctx, store, scope, executionID)
	if pair.steps.gate.Status != wfstore.ExecutionRunning {
		t.Fatalf("gate step = %s", pair.steps.gate.Status)
	}
	if pair.jobs.gate.Status != wfstore.JobClaimed || pair.jobs.gate.Attempt != attempt {
		t.Fatalf("gate job = %s attempt %d", pair.jobs.gate.Status, pair.jobs.gate.Attempt)
	}
}

func assertGateRequeued(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string, attempt int) {
	t.Helper()
	exec, err := store.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if exec.Status == wfstore.ExecutionFailed || exec.Status == wfstore.ExecutionWaiting {
		t.Fatalf("run = %s", exec.Status)
	}
	pair := gateAndLate(t, ctx, store, scope, executionID)
	step, job := pair.steps, pair.jobs
	if step.gate.Status != wfstore.ExecutionQueued || job.gate.Status != wfstore.JobQueued || job.gate.Attempt != attempt {
		t.Fatalf("gate step=%s job=%s attempt=%d", step.gate.Status, job.gate.Status, job.gate.Attempt)
	}
	if port, _ := step.gate.Output["port"].(string); port == "expired" {
		t.Fatalf("gate took expired: %+v", step.gate.Output)
	}
	if step.late.Status == wfstore.ExecutionSucceeded || job.late.Status == wfstore.JobSucceeded {
		t.Fatalf("late step=%s job=%s", step.late.Status, job.late.Status)
	}
	if port, _ := step.late.Output["port"].(string); port == "expired" {
		t.Fatalf("late ran: %+v", step.late.Output)
	}
}

type gateLate struct {
	steps struct {
		gate, late wfstore.ExecutionStep
	}
	jobs struct {
		gate, late wfstore.ExecutionJob
	}
}

func gateAndLate(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string) gateLate {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var out gateLate
	for _, step := range steps {
		switch step.NodeID {
		case "gate":
			out.steps.gate = step
		case "late":
			out.steps.late = step
		}
	}
	for _, job := range jobs {
		switch job.ExecutionStepID {
		case out.steps.gate.ID:
			out.jobs.gate = job
		case out.steps.late.ID:
			out.jobs.late = job
		}
	}
	return out
}
