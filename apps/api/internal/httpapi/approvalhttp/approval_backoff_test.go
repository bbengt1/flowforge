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
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPersistentPrivilegeSpacesClaims(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, scope, exec := startBackoffRun(t, ctx, "bo")
	clock := time.Now().UTC()
	start := clock
	srv := &core.Server{Workflows: privilegeVersions{Postgres: store}, Clock: func() time.Time { return clock }}
	for round := 0; round < 2; round++ {
		got, err := store.ClaimJob(ctx, scope, clock, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil || got.Step.NodeID != "gate" || got.Job.Attempt != 1 {
			t.Fatalf("claim %d = %s attempt %d %v", round, got.Step.NodeID, got.Job.Attempt, err)
		}
		if _, err := ParkApprovalClaim(srv, ctx, scope, got); !errors.Is(err, approval.ErrBindingTransient) {
			t.Fatalf("park = %v", err)
		}
		job := postgresGateJob(t, ctx, store, scope, exec.ID)
		if job.Status != wfstore.JobQueued || job.Attempt != 1 {
			t.Fatalf("released = %+v", job)
		}
		assertFlatDelay(t, job.AvailableAt.Sub(clock))
		early := clock.Add(25*time.Second - time.Millisecond)
		if _, err := store.ClaimJob(ctx, scope, early, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, wfstore.ErrEmptyClaim) {
			t.Fatalf("claimed before 25s on round %d: %v", round, err)
		}
		clock = clock.Add(35 * time.Second)
	}
	if _, err := store.ClaimJob(ctx, scope, clock, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); err != nil {
		t.Fatal(err)
	}
	// expiresIn is PT1H. Recovery before that deadline must not take expired.
	beforeDeadline := start.Add(50 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, beforeDeadline); err != nil {
		t.Fatal(err)
	}
	job := postgresGateJob(t, ctx, store, scope, exec.ID)
	if job.Status != wfstore.JobQueued || job.Attempt != 1 {
		t.Fatalf("before deadline = %+v", job)
	}
	assertPostgresNotExpired(t, ctx, store, scope, exec.ID)
}

func TestLeaseRecoveryBackoff(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, scope, exec := startBackoffRun(t, ctx, "rb")
	frozen := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, frozen, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	attempt := claimed.Job.Attempt
	srv := &core.Server{Workflows: privilegeNoRelease{Postgres: store}, Clock: func() time.Time { return frozen }}
	if _, err := ParkApprovalClaim(srv, ctx, scope, claimed); !errors.Is(err, approval.ErrBindingTransient) {
		t.Fatalf("park = %v", err)
	}
	held := postgresGateJob(t, ctx, store, scope, exec.ID)
	if held.Status != wfstore.JobClaimed || held.Attempt != attempt {
		t.Fatalf("still claimed = %+v", held)
	}
	recoverAt := frozen.Add(2 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job := postgresGateJob(t, ctx, store, scope, exec.ID)
	if job.Status != wfstore.JobQueued || job.Attempt != attempt {
		t.Fatalf("requeue = %+v", job)
	}
	assertFlatDelay(t, job.AvailableAt.Sub(recoverAt))
	if _, err := store.ClaimJob(ctx, scope, recoverAt.Add(25*time.Second-time.Millisecond), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, wfstore.ErrEmptyClaim) {
		t.Fatalf("claimed before 25s: %v", err)
	}
	claimed, err = store.ClaimJob(ctx, scope, recoverAt.Add(35*time.Second), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Job.Attempt != attempt {
		t.Fatalf("reclaim = %+v %v", claimed.Job, err)
	}
	beforeDeadline := frozen.Add(50 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, beforeDeadline); err != nil {
		t.Fatal(err)
	}
	job = postgresGateJob(t, ctx, store, scope, exec.ID)
	if job.Status != wfstore.JobQueued || job.Attempt != attempt {
		t.Fatalf("before deadline = %+v", job)
	}
	assertFlatDelay(t, job.AvailableAt.Sub(beforeDeadline))
	assertPostgresNotExpired(t, ctx, store, scope, exec.ID)
}

type privilegeVersions struct {
	*wfstore.Postgres
}

func (privilegeVersions) GetVersion(context.Context, isolation.Scope, string, string) (wfstore.Version, error) {
	return wfstore.Version{}, errors.Join(wfstore.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
}

type privilegeNoRelease struct {
	*wfstore.Postgres
}

func (privilegeNoRelease) GetVersion(context.Context, isolation.Scope, string, string) (wfstore.Version, error) {
	return wfstore.Version{}, errors.Join(wfstore.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
}

func (privilegeNoRelease) ReleaseJob(context.Context, isolation.Scope, time.Time, wfstore.JobActionInput) (wfstore.DispatchResult, error) {
	return wfstore.DispatchResult{}, errors.New("release failed")
}

func startBackoffRun(t *testing.T, ctx context.Context, tag string) (*wfstore.Postgres, isolation.Scope, wfstore.Execution) {
	t.Helper()
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
	t.Cleanup(admin.Close)
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, fmt.Sprintf("%s-%d", tag, suffix%100000000), "BO")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", fmt.Sprintf("%su-%d", tag, suffix%100000000), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, fmt.Sprintf("%sd-%d", tag, suffix%100000000), "Desk", user.ID)
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
  name: backoff-` + tag + `-` + fmt.Sprintf("%d", suffix%100000000) + `
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
	return store, scope, exec
}

func postgresGateJob(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string) wfstore.ExecutionJob {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var stepID string
	for _, step := range steps {
		if step.NodeID == "gate" {
			stepID = step.ID
		}
	}
	for _, job := range jobs {
		if job.ExecutionStepID == stepID {
			return job
		}
	}
	t.Fatal("missing gate job")
	return wfstore.ExecutionJob{}
}

func assertFlatDelay(t *testing.T, delay time.Duration) {
	t.Helper()
	if delay < 25*time.Second-time.Millisecond || delay > 35*time.Second+time.Millisecond {
		t.Fatalf("delay = %s want 25s..35s", delay)
	}
}

func assertPostgresNotExpired(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string) {
	t.Helper()
	exec, err := store.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if exec.Status == wfstore.ExecutionFailed || exec.Status == wfstore.ExecutionWaiting {
		t.Fatalf("run = %s", exec.Status)
	}
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if port, _ := step.Output["port"].(string); port == "expired" {
			t.Fatalf("%s took expired", step.NodeID)
		}
		if step.NodeID == "late" && step.Status == wfstore.ExecutionSucceeded {
			t.Fatal("late ran")
		}
	}
}
