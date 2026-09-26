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
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
		early := clock.Add(30*time.Second - time.Millisecond)
		if _, err := store.ClaimJob(ctx, scope, early, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, wfstore.ErrEmptyClaim) {
			t.Fatalf("claimed before 30s on round %d: %v", round, err)
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
	if _, err := store.ClaimJob(ctx, scope, recoverAt.Add(30*time.Second-time.Millisecond), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, wfstore.ErrEmptyClaim) {
		t.Fatalf("claimed before 30s: %v", err)
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

func TestTransientPastDeadlineFailsUnresolvable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, scope, exec := startBackoffRunExpiry(t, ctx, "bd", "PT1S")
	frozen := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, frozen, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: 5 * time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	attempt := claimed.Job.Attempt
	parkAt := claimed.Job.CreatedAt.Add(30 * time.Second)
	srv := &core.Server{Workflows: privilegeVersions{Postgres: store}, Clock: func() time.Time { return parkAt }}
	if _, err := ParkApprovalClaim(srv, ctx, scope, claimed); !errors.Is(err, approval.ErrBindingUnresolved) || errors.Is(err, approval.ErrBindingTransient) {
		t.Fatalf("park = %v", err)
	}
	job := postgresGateJob(t, ctx, store, scope, exec.ID)
	if job.Status != wfstore.JobFailed || job.Attempt != attempt {
		t.Fatalf("past deadline = %+v", job)
	}
	assertRequirementUnresolvable(t, ctx, store, scope, exec.ID)

	store, scope, exec = startBackoffRun(t, ctx, "br")
	claimed, err = store.ClaimJob(ctx, scope, time.Now().UTC(), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	attempt = claimed.Job.Attempt
	recoverAt := claimed.Job.CreatedAt.Add(2 * time.Hour)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job = postgresGateJob(t, ctx, store, scope, exec.ID)
	if job.Status != wfstore.JobFailed || job.Attempt != attempt {
		t.Fatalf("recovery past deadline = %+v", job)
	}
	assertRequirementUnresolvable(t, ctx, store, scope, exec.ID)
}

func TestDeadlineAnchorSurvivesRequeueRecoveryAndReclaim(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, scope, exec := startBackoffRun(t, ctx, "an")
	now := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	anchor, stepAnchor := claimed.Job.CreatedAt, claimed.Step.CreatedAt
	released, err := store.ReleaseJob(ctx, scope, now, wfstore.JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
		ApprovalTransientRetry: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !released.Job.CreatedAt.Equal(anchor) || !released.Step.CreatedAt.Equal(stepAnchor) {
		t.Fatalf("release moved anchor job %s step %s", released.Job.CreatedAt, released.Step.CreatedAt)
	}
	claimed, err = store.ClaimJob(ctx, scope, now.Add(35*time.Second), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if !claimed.Job.CreatedAt.Equal(anchor) || !claimed.Step.CreatedAt.Equal(stepAnchor) {
		t.Fatalf("reclaim moved anchor job %s step %s", claimed.Job.CreatedAt, claimed.Step.CreatedAt)
	}
	recoverAt := now.Add(2 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job := postgresGateJob(t, ctx, store, scope, exec.ID)
	stepAt := postgresGateStepCreated(t, ctx, store, scope, exec.ID)
	if !job.CreatedAt.Equal(anchor) || !stepAt.Equal(stepAnchor) {
		t.Fatalf("recovery moved anchor job %s step %s", job.CreatedAt, stepAt)
	}
	claimed, err = store.ClaimJob(ctx, scope, recoverAt.Add(35*time.Second), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if !claimed.Job.CreatedAt.Equal(anchor) || !claimed.Step.CreatedAt.Equal(stepAnchor) {
		t.Fatalf("restart reclaim moved anchor job %s step %s", claimed.Job.CreatedAt, claimed.Step.CreatedAt)
	}
}

func TestPastLimitCancelsPendingApproval(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, scope, exec := startBackoffRun(t, ctx, "cu")
	now := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	insertPendingGate(t, ctx, scope, exec, time.Now().UTC().Add(time.Hour))
	recoverAt := claimed.Job.CreatedAt.Add(2 * time.Hour)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job := postgresGateJob(t, ctx, store, scope, exec.ID)
	if job.Status != wfstore.JobFailed || job.Attempt != claimed.Job.Attempt {
		t.Fatalf("recovery past deadline = %+v", job)
	}
	assertRequirementUnresolvable(t, ctx, store, scope, exec.ID)
	status, reason, decided := approvalGateRow(t, ctx, scope, exec.ID)
	if status != approval.StatusCanceled || reason != approval.ReasonRequirementUnresolvable || decided != "" {
		t.Fatalf("approval = %s %s decided=%q", status, reason, decided)
	}

	store, scope, exec = startBackoffRunExpiry(t, ctx, "cf", "PT1S")
	claimed, err = store.ClaimJob(ctx, scope, time.Now().UTC(), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: 5 * time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	insertPendingGate(t, ctx, scope, exec, time.Now().UTC().Add(time.Hour))
	failAt := claimed.Job.CreatedAt.Add(30 * time.Second)
	if _, err := store.FailJob(ctx, scope, failAt, wfstore.JobActionInput{
		JobID: claimed.Job.ID, WorkerID: claimed.Job.WorkerID, FencingToken: claimed.Job.FencingToken,
		Error: map[string]any{
			"code":    wfstore.ReasonRequirementUnresolvable,
			"message": "The approval requirement could not be rebuilt.",
		},
	}); err != nil {
		t.Fatal(err)
	}
	assertRequirementUnresolvable(t, ctx, store, scope, exec.ID)
	status, reason, decided = approvalGateRow(t, ctx, scope, exec.ID)
	if status != approval.StatusCanceled || reason != approval.ReasonRequirementUnresolvable || decided != "" {
		t.Fatalf("fail approval = %s %s decided=%q", status, reason, decided)
	}
}

func TestWaitingGateStillExpires(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	store, scope, exec := startBackoffRun(t, ctx, "wx")
	now := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	limit, ok := wfstore.ApprovalRetryLimit(claimed.Job.CreatedAt, time.Time{}, claimed.Step.Input)
	if !ok {
		t.Fatal("missing limit")
	}
	if _, err := store.WaitJob(ctx, scope, now, wfstore.WaitJobInput{
		JobID:       claimed.Job.ID,
		AvailableAt: limit,
		Approval: &wfstore.ParkedApproval{
			WorkflowID:        exec.WorkflowID,
			WorkflowVersionID: exec.WorkflowVersionID,
			WorkflowDigest:    exec.WorkflowDigest,
			ExecutionID:       exec.ID,
			RequestedBy:       exec.RequestedBy,
			NodeID:            "gate",
			NodeName:          "Gate",
			Operation:         "flow.approval",
			ApproverRole:      "approver",
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecoverExpiredLeases(ctx, scope, limit); err != nil {
		t.Fatal(err)
	}
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	var gate wfstore.ExecutionStep
	for _, step := range steps {
		if step.NodeID == "gate" {
			gate = step
		}
	}
	if gate.Status != wfstore.ExecutionSucceeded || gate.Output["port"] != "expired" {
		t.Fatalf("waiting gate = %+v", gate)
	}
	if gate.Error["code"] == wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("waiting gate failed unresolvable: %+v", gate)
	}
	status, reason, decided := approvalGateRow(t, ctx, scope, exec.ID)
	if status != approval.StatusExpired || reason != "" || decided != "" {
		t.Fatalf("expired approval = %s %s decided=%q", status, reason, decided)
	}
}

func TestRetryLimitFollowsPendingExpiry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	t.Run("follows expires_at", func(t *testing.T) {
		store, scope, exec := startBackoffRun(t, ctx, "ex")
		claimed, err := store.ClaimJob(ctx, scope, time.Now().UTC(), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil || claimed.Step.NodeID != "gate" {
			t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
		}
		anchor := claimed.Job.CreatedAt
		expires := anchor.Add(3 * time.Hour)
		insertPendingGate(t, ctx, scope, exec, expires)
		recoverAt := anchor.Add(2 * time.Hour)
		if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
			t.Fatal(err)
		}
		job := postgresGateJob(t, ctx, store, scope, exec.ID)
		if job.Status != wfstore.JobWaiting || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("inside approval deadline = %+v", job)
		}
		status, reason, decided := approvalGateRow(t, ctx, scope, exec.ID)
		if status != approval.StatusPending || reason != "" || decided != "" {
			t.Fatalf("approval = %s %s decided=%q", status, reason, decided)
		}
		if got := approvalGateExpiry(t, ctx, scope, exec.ID); !got.Equal(expires) {
			t.Fatalf("expires_at = %s want %s", got, expires)
		}
		steps, err := store.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range steps {
			if port, _ := step.Output["port"].(string); port == "expired" {
				t.Fatalf("%s took expired", step.NodeID)
			}
			if step.NodeID == "gate" && step.Error["code"] == wfstore.ReasonRequirementUnresolvable {
				t.Fatalf("gate failed early: %+v", step)
			}
		}
	})
	t.Run("falls back to created_at", func(t *testing.T) {
		store, scope, exec := startBackoffRun(t, ctx, "fb")
		claimed, err := store.ClaimJob(ctx, scope, time.Now().UTC(), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil || claimed.Step.NodeID != "gate" {
			t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
		}
		anchor := claimed.Job.CreatedAt
		if _, err := store.RecoverExpiredLeases(ctx, scope, anchor.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		job := postgresGateJob(t, ctx, store, scope, exec.ID)
		if job.Status != wfstore.JobFailed || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("created_at limit = %+v", job)
		}
		assertRequirementUnresolvable(t, ctx, store, scope, exec.ID)
	})
	t.Run("closes pending at the limit", func(t *testing.T) {
		store, scope, exec := startBackoffRun(t, ctx, "cl")
		claimed, err := store.ClaimJob(ctx, scope, time.Now().UTC(), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil || claimed.Step.NodeID != "gate" {
			t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
		}
		anchor := claimed.Job.CreatedAt
		expires := anchor.Add(3 * time.Hour)
		insertPendingGate(t, ctx, scope, exec, expires)
		if _, err := store.RecoverExpiredLeases(ctx, scope, expires); err != nil {
			t.Fatal(err)
		}
		job := postgresGateJob(t, ctx, store, scope, exec.ID)
		if job.Status != wfstore.JobFailed || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("at expires_at = %+v", job)
		}
		assertRequirementUnresolvable(t, ctx, store, scope, exec.ID)
		status, reason, decided := approvalGateRow(t, ctx, scope, exec.ID)
		if status != approval.StatusCanceled || reason != approval.ReasonRequirementUnresolvable || decided != "" {
			t.Fatalf("approval = %s %s decided=%q", status, reason, decided)
		}
	})
	t.Run("compose release follows expires_at", func(t *testing.T) {
		store, scope, exec := startBackoffRunExpiry(t, ctx, "cr", "PT1S")
		claimed, err := store.ClaimJob(ctx, scope, time.Now().UTC(), wfstore.ClaimInput{WorkerID: "edge-worker", Lease: 5 * time.Minute})
		if err != nil || claimed.Step.NodeID != "gate" {
			t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
		}
		anchor := claimed.Job.CreatedAt
		expires := anchor.Add(4 * time.Minute)
		insertPendingGate(t, ctx, scope, exec, expires)
		early := anchor.Add(30 * time.Second)
		srv := &core.Server{Workflows: privilegeVersions{Postgres: store}, Clock: func() time.Time { return early }}
		if _, err := ParkApprovalClaim(srv, ctx, scope, claimed); !errors.Is(err, approval.ErrBindingTransient) {
			t.Fatalf("early park = %v", err)
		}
		job := postgresGateJob(t, ctx, store, scope, exec.ID)
		if job.Status != wfstore.JobQueued || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("before expires_at = %+v", job)
		}
		status, reason, decided := approvalGateRow(t, ctx, scope, exec.ID)
		if status != approval.StatusPending || reason != "" || decided != "" {
			t.Fatalf("early approval = %s %s decided=%q", status, reason, decided)
		}
		if got := approvalGateExpiry(t, ctx, scope, exec.ID); !got.Equal(expires) {
			t.Fatalf("expires_at = %s want %s", got, expires)
		}
		claimed, err = store.ClaimJob(ctx, scope, expires, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil || claimed.Step.NodeID != "gate" {
			t.Fatalf("reclaim = %s %v", claimed.Step.NodeID, err)
		}
		if !claimed.Job.CreatedAt.Equal(anchor) {
			t.Fatalf("reclaim moved created_at to %s", claimed.Job.CreatedAt)
		}
		srv = &core.Server{Workflows: privilegeVersions{Postgres: store}, Clock: func() time.Time { return expires }}
		if _, err := ParkApprovalClaim(srv, ctx, scope, claimed); !errors.Is(err, approval.ErrBindingUnresolved) || errors.Is(err, approval.ErrBindingTransient) {
			t.Fatalf("at limit = %v", err)
		}
		job = postgresGateJob(t, ctx, store, scope, exec.ID)
		if job.Status != wfstore.JobFailed || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("at expires_at = %+v", job)
		}
		assertRequirementUnresolvable(t, ctx, store, scope, exec.ID)
		status, reason, decided = approvalGateRow(t, ctx, scope, exec.ID)
		if status != approval.StatusCanceled || reason != approval.ReasonRequirementUnresolvable || decided != "" {
			t.Fatalf("closed approval = %s %s decided=%q", status, reason, decided)
		}
	})
}

func insertPendingGate(t *testing.T, ctx context.Context, scope isolation.Scope, exec wfstore.Execution, expires time.Time) {
	t.Helper()
	app := openBackoffDB(t, ctx)
	defer app.Close()
	tx, err := postgres.BeginScoped(ctx, app, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	err = parkedapproval.Insert(ctx, tx, parkedapproval.Pending{
		WorkspaceID:       scope.WorkspaceID(),
		ActorID:           scope.ActorID(),
		WorkflowID:        exec.WorkflowID,
		WorkflowVersionID: exec.WorkflowVersionID,
		WorkflowDigest:    exec.WorkflowDigest,
		ExecutionID:       exec.ID,
		RequestedBy:       exec.RequestedBy,
		NodeID:            "gate",
		NodeName:          "Gate",
		Operation:         "flow.approval",
		ApproverRole:      "approver",
		ExpiresAt:         expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func approvalGateRow(t *testing.T, ctx context.Context, scope isolation.Scope, executionID string) (status, reason, decidedBy string) {
	t.Helper()
	app := openBackoffDB(t, ctx)
	defer app.Close()
	tx, err := postgres.BeginScoped(ctx, app, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `
		SELECT status, COALESCE(close_reason, ''), COALESCE(decided_by::text, '')
		  FROM approvals
		 WHERE execution_id = $1::uuid AND node_id = 'gate'
	`, executionID).Scan(&status, &reason, &decidedBy)
	if err != nil {
		t.Fatal(err)
	}
	return status, reason, decidedBy
}

func approvalGateExpiry(t *testing.T, ctx context.Context, scope isolation.Scope, executionID string) time.Time {
	t.Helper()
	app := openBackoffDB(t, ctx)
	defer app.Close()
	tx, err := postgres.BeginScoped(ctx, app, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var expires time.Time
	err = tx.QueryRow(ctx, `
		SELECT expires_at FROM approvals
		 WHERE execution_id = $1::uuid AND node_id = 'gate'
	`, executionID).Scan(&expires)
	if err != nil {
		t.Fatal(err)
	}
	return expires.UTC()
}

func openBackoffDB(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func assertRequirementUnresolvable(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string) {
	t.Helper()
	exec, err := store.GetExecutionByID(ctx, scope, executionID)
	if err != nil || exec.Status != wfstore.ExecutionFailed {
		t.Fatalf("run = %+v %v", exec, err)
	}
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == "gate" && (step.Status != wfstore.ExecutionFailed || step.Error["code"] != wfstore.ReasonRequirementUnresolvable) {
			t.Fatalf("gate = %+v", step)
		}
		if port, _ := step.Output["port"].(string); port == "expired" {
			t.Fatalf("%s took expired", step.NodeID)
		}
		if step.NodeID == "late" && step.Status == wfstore.ExecutionSucceeded {
			t.Fatal("late ran")
		}
	}
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
	return startBackoffRunExpiry(t, ctx, tag, "PT1H")
}

func startBackoffRunExpiry(t *testing.T, ctx context.Context, tag, expires string) (*wfstore.Postgres, isolation.Scope, wfstore.Execution) {
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
        expiresIn: ` + expires + `
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

func postgresGateStepCreated(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string) time.Time {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == "gate" {
			return step.CreatedAt
		}
	}
	t.Fatal("missing gate step")
	return time.Time{}
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
	if delay < 30*time.Second || delay > 35*time.Second+time.Millisecond {
		t.Fatalf("delay = %s want 30s..35s", delay)
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
