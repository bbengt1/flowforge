package wfstore

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const conditionNullYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: condition-null
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
          present: true
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: exists
    - id: yes
      type: flow.stop
      name: Yes
      with:
        status: success
    - id: no
      type: flow.stop
      name: No
      with:
        status: success
  edges:
    - from: seed.result
      to: gate.value
    - from: gate.true
      to: yes.input
    - from: gate.false
      to: no.input
`

func TestPostgresRetryAndApprovalClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
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
	store := NewPostgres(app)
	ws, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(ws, userID)
	if err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }

	t.Run("cancel then retry gated step", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateThenStopYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gateClaim.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
		after := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "after")
		_, err := store.RetryStep(ctx, scope, now(), exec.ID, after.ID)
		var refused *NotRetryableError
		if !errors.As(err, &refused) || refused.Reason != ReasonRunCanceled {
			t.Fatalf("retry = %v", err)
		}
		if n := countNodeJobs(t, ctx, store, scope, exec.ID, "after"); n != 1 {
			t.Fatalf("after jobs=%d", n)
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionCanceled)
	})

	t.Run("retry never started", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{
			JobID: seedClaim.Job.ID, WorkerID: "edge-worker", FencingToken: seedClaim.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		next := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "next")
		_, err := store.RetryStep(ctx, scope, now(), exec.ID, next.ID)
		var refused *NotRetryableError
		if !errors.As(err, &refused) || refused.Reason != ReasonStepNotStarted {
			t.Fatalf("retry = %v", err)
		}
	})

	t.Run("superseded attempt", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{
			JobID: seedClaim.Job.ID, WorkerID: "edge-worker", FencingToken: seedClaim.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now(), exec.ID, seedClaim.Step.ID); err != nil {
			t.Fatal(err)
		}
		_, err := store.RetryStep(ctx, scope, now(), exec.ID, seedClaim.Step.ID)
		if !errors.Is(err, ErrStepAttemptSuperseded) {
			t.Fatalf("retry = %v", err)
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("successful retry finishes and releases", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{
			JobID: seedClaim.Job.ID, WorkerID: "edge-worker", FencingToken: seedClaim.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionPending, JobBlocked)
		retried, err := store.RetryStep(ctx, scope, now(), exec.ID, seedClaim.Step.ID)
		if err != nil {
			t.Fatal(err)
		}
		if retried.Step.UnresolvedIncoming != 0 {
			t.Fatalf("unresolved = %d", retried.Step.UnresolvedIncoming)
		}
		again := claimNode(t, ctx, store, scope, now(), "seed")
		if again.Step.ID != retried.Step.ID {
			t.Fatalf("claimed %s, want retry %s", again.Step.ID, retried.Step.ID)
		}
		completeJob(t, ctx, store, scope, now(), again, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionQueued, JobQueued)
		nextClaim := claimNode(t, ctx, store, scope, now(), "next")
		completeJob(t, ctx, store, scope, now(), nextClaim, map[string]any{"result": map[string]any{"status": "success"}})
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("condition null routes one branch", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, conditionNullYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"present": true}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		res, errs := workflow.Evaluate("flow.condition", map[string]any{"op": "exists"}, map[string]any{"value": nil})
		if len(errs) > 0 || res == nil || res.Outputs["port"] != "false" {
			t.Fatalf("eval = %+v %+v", res, errs)
		}
		completeJob(t, ctx, store, scope, now(), gateClaim, res.Outputs)
		assertNode(t, ctx, store, scope, exec.ID, "yes", ExecutionSkipped, JobSkipped)
		assertNode(t, ctx, store, scope, exec.ID, "no", ExecutionQueued, JobQueued)
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("backfill skips rejected gate and keeps failed edges open", func(t *testing.T) {
		_, ver := publishOnly(t, ctx, store, scope, gateThenStopYAML)
		execID := insertRejectedLegacy(t, ctx, admin, ws, userID, ver)
		if _, err := admin.Exec(ctx, `SELECT app.backfill_execution_edge_resolution()`); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, execID, "after", ExecutionSkipped, JobSkipped)

		live := startGraph(t, ctx, store, scope, retryChainYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{
			JobID: seedClaim.Job.ID, WorkerID: "edge-worker", FencingToken: seedClaim.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `SELECT app.backfill_execution_edge_resolution()`); err != nil {
			t.Fatal(err)
		}
		var resolved, satisfied bool
		if err := admin.QueryRow(ctx, `
			SELECT resolved, satisfied FROM execution_edges
			 WHERE execution_id = $1::uuid AND from_node = 'seed'
		`, live.ID).Scan(&resolved, &satisfied); err != nil {
			t.Fatal(err)
		}
		if resolved || satisfied {
			t.Fatalf("failed edge resolved=%v satisfied=%v", resolved, satisfied)
		}
		assertNode(t, ctx, store, scope, live.ID, "next", ExecutionPending, JobBlocked)
	})

	t.Run("cancel races resume and complete", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateThenStopYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gateClaim.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		assertNoDeadlock(t, func() error {
			_, err := store.CancelExecution(ctx, scope, now(), exec.ID)
			return err
		}, func() error {
			_, err := store.ResumeWait(ctx, scope, now(), ResumeWaitInput{JobID: gateClaim.Job.ID, Port: "approved"})
			return err
		})
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil && !errors.Is(err, ErrAlreadyTerminal) {
			t.Fatal(err)
		}

		other := startGraph(t, ctx, store, scope, retryChainYAML)
		claimed := claimNode(t, ctx, store, scope, now(), "seed")
		assertNoDeadlock(t, func() error {
			_, err := store.CancelExecution(ctx, scope, now(), other.ID)
			return err
		}, func() error {
			_, err := store.CompleteJob(ctx, scope, now(), JobActionInput{
				JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
				Output: map[string]any{"result": map[string]any{"ticket": "CHG-1"}},
			})
			return err
		})
	})
}

func insertRejectedLegacy(t *testing.T, ctx context.Context, admin *pgxpool.Pool, ws, userID string, ver Version) string {
	t.Helper()
	var execID string
	if err := admin.QueryRow(ctx, `
		INSERT INTO executions (
			workspace_id, workflow_id, workflow_version_id, workflow_digest, status, requested_by
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'waiting', $5::uuid)
		RETURNING id::text
	`, ws, ver.WorkflowID, ver.ID, ver.Digest, userID).Scan(&execID); err != nil {
		t.Fatal(err)
	}
	insert := func(node, typ, status, output string) string {
		t.Helper()
		var id string
		if err := admin.QueryRow(ctx, `
			INSERT INTO execution_steps (
				workspace_id, execution_id, node_id, node_type, attempt, status, output_redacted
			) VALUES ($1::uuid, $2::uuid, $3, $4, 1, $5, $6::jsonb)
			RETURNING id::text
		`, ws, execID, node, typ, status, output).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	gateID := insert("gate", "flow.approval", ExecutionSucceeded, `{"port":"rejected","decision":"rejected"}`)
	afterID := insert("after", "flow.stop", ExecutionQueued, `{}`)
	if _, err := admin.Exec(ctx, `
		INSERT INTO execution_jobs (workspace_id, execution_id, execution_step_id, status, available_at, attempt)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'succeeded', now(), 1),
		       ($1::uuid, $2::uuid, $4::uuid, 'queued', now(), 1)
	`, ws, execID, gateID, afterID); err != nil {
		t.Fatal(err)
	}
	return execID
}

func assertNoDeadlock(t *testing.T, a, b func() error) {
	t.Helper()
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		errs <- a()
	}()
	go func() {
		defer wg.Done()
		errs <- b()
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "55P03") {
			t.Fatalf("deadlock %s: %v", pgErr.Code, err)
		}
	}
}
