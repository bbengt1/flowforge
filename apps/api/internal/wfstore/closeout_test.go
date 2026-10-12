package wfstore

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/migrations"
)

const failWithParkedGateYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: fail-with-parked-gate
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
          ticket: CHG-1
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1H
    - id: run
      type: ssh.run
      name: Run
      with:
        sshTargetId: 11111111-1111-4111-8111-111111111111
        commandProfileId: 22222222-2222-4222-8222-222222222222
    - id: join
      type: kubernetes.apply
      name: Join
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: demo
  edges:
    - from: seed.result
      to: gate.request
    - from: gate.approved
      to: join.parameters
    - from: run.stdout
      to: join.manifests
`

func assertSkipReason(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, executionID, node, reason string) {
	t.Helper()
	step := stepByNode(t, listSteps(t, ctx, store, scope, executionID), node)
	if step.SkipReason != reason {
		t.Fatalf("%s skipReason=%q, want %q", node, step.SkipReason, reason)
	}
}

func closeAudits(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, action, executionID string) []AuditEvent {
	t.Helper()
	got, err := store.ListAuditEvents(ctx, scope, AuditListFilter{Action: action, ResourceID: executionID})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func failClaim(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, now time.Time, c DispatchResult) {
	t.Helper()
	if _, err := store.FailJob(ctx, scope, now, JobActionInput{
		JobID: c.Job.ID, WorkerID: "edge-worker", FencingToken: c.Job.FencingToken,
		Error: map[string]any{"code": "boom"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresCloseOut(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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
	ws, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(ws, userID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }

	t.Run("failed rollup closes out, retry reopens on accept", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		seed := claimNode(t, ctx, store, scope, now(), "seed")
		failClaim(t, ctx, store, scope, now(), seed)
		assertRun(t, ctx, store, scope, exec.ID, ExecutionFailed)
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionSkipped, JobSkipped)
		assertSkipReason(t, ctx, store, scope, exec.ID, "next", SkipUpstreamFailed)
		audits := closeAudits(t, ctx, store, scope, ActionStepsClosed, exec.ID)
		if len(audits) != 1 {
			t.Fatalf("close audits = %+v", audits)
		}
		d := audits[0].Details
		if d["reason"] != SkipUpstreamFailed || num(d["steps"]) != 1 || num(d["jobs"]) != 1 || len(d) != 3 {
			t.Fatalf("close audit details = %+v", d)
		}
		// RLS: another workspace sees neither the steps nor the audit row.
		if steps, err := store.ListSteps(ctx, scopeB, exec.ID); err == nil && len(steps) != 0 {
			t.Fatalf("cross-workspace steps = %+v", steps)
		}
		if other := closeAudits(t, ctx, store, scopeB, ActionStepsClosed, exec.ID); len(other) != 0 {
			t.Fatalf("cross-workspace audits = %+v", other)
		}
		crossTx, err := postgres.BeginScoped(ctx, app, wsB)
		if err != nil {
			t.Fatal(err)
		}
		var crossRows int
		err = crossTx.QueryRow(ctx, `SELECT count(*) FROM execution_steps WHERE execution_id = $1::uuid AND skip_reason IS NOT NULL`, exec.ID).Scan(&crossRows)
		_ = crossTx.Rollback(ctx)
		if err != nil || crossRows != 0 {
			t.Fatalf("cross-workspace raw rows = %d %v", crossRows, err)
		}

		// Reopen happens when the retry is accepted, before the retry runs.
		if _, err := store.RetryStep(ctx, scope, now(), exec.ID, seed.Step.ID); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionPending, JobBlocked)
		assertSkipReason(t, ctx, store, scope, exec.ID, "next", "")
		if got := closeAudits(t, ctx, store, scope, ActionStepsReopened, exec.ID); len(got) != 1 || num(got[0].Details["steps"]) != 1 {
			t.Fatalf("reopen audits = %+v", got)
		}
		again := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), again, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		next := claimNode(t, ctx, store, scope, now(), "next")
		completeJob(t, ctx, store, scope, now(), next, map[string]any{"result": map[string]any{"status": "success"}})
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("cancel closes never-run steps as run_canceled", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateThenStopYAML)
		seed := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seed, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gate := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gate.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionCanceled)
		// The parked step had started: it keeps the legacy canceled status.
		assertNode(t, ctx, store, scope, exec.ID, "gate", ExecutionCanceled, JobCanceled)
		assertSkipReason(t, ctx, store, scope, exec.ID, "gate", "")
		assertNode(t, ctx, store, scope, exec.ID, "after", ExecutionSkipped, JobSkipped)
		assertSkipReason(t, ctx, store, scope, exec.ID, "after", SkipRunCanceled)
		// Retry on a canceled run stays refused, and run_canceled never reopens.
		if _, err := store.RetryStep(ctx, scope, now(), exec.ID, gate.Step.ID); err == nil {
			t.Fatal("retry on canceled run accepted")
		}
		reopenDirect(t, ctx, app, scope, exec.ID)
		assertNode(t, ctx, store, scope, exec.ID, "after", ExecutionSkipped, JobSkipped)
		assertSkipReason(t, ctx, store, scope, exec.ID, "after", SkipRunCanceled)
	})

	t.Run("delete closes parked run as workflow_deleted and never reopens", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateThenStopYAML)
		seed := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seed, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gate := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gate.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Delete(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "after", ExecutionSkipped, JobSkipped)
		assertSkipReason(t, ctx, store, scope, exec.ID, "after", SkipWorkflowDeleted)
		_, _ = store.RetryStep(ctx, scope, now(), exec.ID, gate.Step.ID)
		assertSkipReason(t, ctx, store, scope, exec.ID, "after", SkipWorkflowDeleted)
		// Even a direct reopen leaves workflow_deleted alone.
		reopenDirect(t, ctx, app, scope, exec.ID)
		assertNode(t, ctx, store, scope, exec.ID, "after", ExecutionSkipped, JobSkipped)
		assertSkipReason(t, ctx, store, scope, exec.ID, "after", SkipWorkflowDeleted)
	})

	t.Run("branch_not_taken never reopens", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, conditionNullYAML)
		seed := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seed, map[string]any{"result": map[string]any{"present": true}})
		gate := claimNode(t, ctx, store, scope, now(), "gate")
		completeJob(t, ctx, store, scope, now(), gate, map[string]any{"port": "false"})
		no := claimNode(t, ctx, store, scope, now(), "no")
		failClaim(t, ctx, store, scope, now(), no)
		assertSkipReason(t, ctx, store, scope, exec.ID, "yes", SkipBranchNotTaken)
		reopenDirect(t, ctx, app, scope, exec.ID)
		assertNode(t, ctx, store, scope, exec.ID, "yes", ExecutionSkipped, JobSkipped)
		assertSkipReason(t, ctx, store, scope, exec.ID, "yes", SkipBranchNotTaken)
	})

	t.Run("indeterminate closes out; retry keeps retrySafe rules", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, sshThenStopYAML)
		run := claimNode(t, ctx, store, scope, now(), "run")
		if n, err := store.RecoverExpiredLeases(ctx, scope, now().Add(2*time.Minute)); err != nil || n < 1 {
			t.Fatalf("recover n=%d err=%v", n, err)
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionIndeterminate)
		assertNode(t, ctx, store, scope, exec.ID, "run", ExecutionIndeterminate, JobIndeterminate)
		assertSkipReason(t, ctx, store, scope, exec.ID, "run", "")
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionSkipped, JobSkipped)
		assertSkipReason(t, ctx, store, scope, exec.ID, "next", SkipUpstreamIndeterminate)
		// Not retrySafe: refused, nothing reopens.
		if _, err := store.RetryStep(ctx, scope, now(), exec.ID, run.Step.ID); err == nil {
			t.Fatal("retry of non-retrySafe indeterminate step accepted")
		}
		assertSkipReason(t, ctx, store, scope, exec.ID, "next", SkipUpstreamIndeterminate)
		// retrySafe with verification: accepted, downstream reopens.
		if _, err := admin.Exec(ctx, `
			UPDATE execution_steps
			   SET policy_snapshot = COALESCE(policy_snapshot, '{}'::jsonb) || '{"retrySafe": true, "verificationDeclared": true}'::jsonb,
			       input_redacted = COALESCE(input_redacted, '{}'::jsonb) || '{"retryPolicy": {"maxAttempts": 2}}'::jsonb
			 WHERE id = $1::uuid`, run.Step.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now(), exec.ID, run.Step.ID); err != nil {
			t.Fatalf("retrySafe retry = %v", err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionPending, JobBlocked)
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("failed branch with parked approval stays waiting", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, failWithParkedGateYAML)
		for i := 0; i < 3; i++ {
			c := claimNode(t, ctx, store, scope, now(), "")
			switch c.Step.NodeID {
			case "seed":
				completeJob(t, ctx, store, scope, now(), c, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
			case "gate":
				if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: c.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
					t.Fatal(err)
				}
			case "run":
				failClaim(t, ctx, store, scope, now(), c)
			default:
				t.Fatalf("claimed %s", c.Step.NodeID)
			}
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionWaiting)
		assertNode(t, ctx, store, scope, exec.ID, "join", ExecutionPending, JobBlocked)
		if got := closeAudits(t, ctx, store, scope, ActionStepsClosed, exec.ID); len(got) != 0 {
			t.Fatalf("closed early: %+v", got)
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
		assertSkipReason(t, ctx, store, scope, exec.ID, "join", SkipRunCanceled)
	})

	t.Run("forced audit failure rolls back the whole transaction", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		seed := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := admin.Exec(ctx, `
			DROP TRIGGER IF EXISTS ff_test_block_closeout ON audit_events;
			CREATE OR REPLACE FUNCTION ff_test_block_closeout() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.action = 'execution.steps_closed' AND NEW.resource_id = '`+exec.ID+`'::uuid THEN
					RAISE EXCEPTION 'closeout audit blocked by test';
				END IF;
				RETURN NEW;
			END $$;
			CREATE TRIGGER ff_test_block_closeout BEFORE INSERT ON audit_events
				FOR EACH ROW EXECUTE FUNCTION ff_test_block_closeout();
		`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = admin.Exec(context.Background(), `DROP TRIGGER IF EXISTS ff_test_block_closeout ON audit_events; DROP FUNCTION IF EXISTS ff_test_block_closeout();`)
		}()
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{
			JobID: seed.Job.ID, WorkerID: "edge-worker", FencingToken: seed.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err == nil {
			t.Fatal("fail succeeded although close-out audit failed")
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionRunning)
		got := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "seed")
		if got.Status == ExecutionFailed {
			t.Fatalf("seed step committed as failed")
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionPending, JobBlocked)
	})

	t.Run("CHECK refuses bad skip_reason rows", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		next := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "next")
		for name, q := range map[string]string{
			"skipped without reason": `UPDATE execution_steps SET status = 'skipped' WHERE id = $1::uuid`,
			"reason without skipped": `UPDATE execution_steps SET skip_reason = 'upstream_failed' WHERE id = $1::uuid`,
			"unknown reason":         `UPDATE execution_steps SET status = 'skipped', skip_reason = 'because' WHERE id = $1::uuid`,
		} {
			if _, err := admin.Exec(ctx, q, next.ID); err == nil {
				t.Fatalf("%s: accepted", name)
			}
		}
		if _, err := admin.Exec(ctx, `UPDATE execution_steps SET status = 'skipped', skip_reason = 'workflow_deleted' WHERE id = $1::uuid`, next.ID); err != nil {
			t.Fatalf("valid row refused: %v", err)
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("legacy canceled never-run rows still read", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		next := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "next")
		if _, err := admin.Exec(ctx, `UPDATE execution_steps SET status = 'canceled' WHERE id = $1::uuid`, next.ID); err != nil {
			t.Fatal(err)
		}
		got := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "next")
		if got.Status != ExecutionCanceled || got.SkipReason != "" {
			t.Fatalf("legacy row = %s %q", got.Status, got.SkipReason)
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})
}

func reopenDirect(t *testing.T, ctx context.Context, app postgres.TxBeginner, scope isolation.Scope, executionID string) {
	t.Helper()
	tx, err := postgres.BeginScoped(ctx, app, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := reopenTx(ctx, tx, scope, executionID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func num(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return -1
}

func TestMemoryCloseOut(t *testing.T) {
	ctx := context.Background()
	var store *Memory
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	start := func(src string) Execution {
		t.Helper()
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
		return exec
	}
	claim := func(node string) DispatchResult {
		t.Helper()
		got, err := store.ClaimJob(ctx, scope, time.Now().UTC().Add(time.Second), ClaimInput{WorkerID: "w", Lease: time.Minute})
		if err != nil || got.Step.NodeID != node {
			t.Fatalf("claim %s = %s %v", node, got.Step.NodeID, err)
		}
		return got
	}
	step := func(execID, node string) (ExecutionStep, ExecutionJob) {
		t.Helper()
		steps, _ := store.ListSteps(ctx, scope, execID)
		jobs, _ := store.ListJobs(ctx, scope, execID)
		s := stepByNode(t, steps, node)
		return s, jobByNode(t, jobs, steps, node)
	}
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }

	t.Run("fail, audit, retry reopen", func(t *testing.T) {
		store = NewMemory()
		exec := start(retryChainYAML)
		seed := claim("seed")
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{JobID: seed.Job.ID, WorkerID: "w", FencingToken: seed.Job.FencingToken, Error: map[string]any{"code": "boom"}}); err != nil {
			t.Fatal(err)
		}
		s, j := step(exec.ID, "next")
		if s.Status != ExecutionSkipped || s.SkipReason != SkipUpstreamFailed || j.Status != JobSkipped {
			t.Fatalf("next = %s %q %s", s.Status, s.SkipReason, j.Status)
		}
		audits, _ := store.ListAuditEvents(ctx, scope, AuditListFilter{Action: ActionStepsClosed, ResourceID: exec.ID})
		if len(audits) != 1 || num(audits[0].Details["steps"]) != 1 || num(audits[0].Details["jobs"]) != 1 {
			t.Fatalf("audits = %+v", audits)
		}
		if _, err := store.RetryStep(ctx, scope, now(), exec.ID, seed.Step.ID); err != nil {
			t.Fatal(err)
		}
		s, j = step(exec.ID, "next")
		if s.Status != ExecutionPending || s.SkipReason != "" || j.Status != JobBlocked {
			t.Fatalf("reopened next = %s %q %s", s.Status, s.SkipReason, j.Status)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		store = NewMemory()
		exec := start(retryChainYAML)
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
		for _, node := range []string{"seed", "next"} {
			s, j := step(exec.ID, node)
			if s.Status != ExecutionSkipped || s.SkipReason != SkipRunCanceled || j.Status != JobSkipped {
				t.Fatalf("%s = %s %q %s", node, s.Status, s.SkipReason, j.Status)
			}
		}
	})

	t.Run("delete parked never reopens", func(t *testing.T) {
		store = NewMemory()
		exec := start(gateThenStopYAML)
		seed := claim("seed")
		if _, err := store.CompleteJob(ctx, scope, now(), JobActionInput{JobID: seed.Job.ID, WorkerID: "w", FencingToken: seed.Job.FencingToken, Output: map[string]any{"result": map[string]any{"ticket": "CHG-1"}}}); err != nil {
			t.Fatal(err)
		}
		gate := claim("gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gate.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Delete(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatal(err)
		}
		s, _ := step(exec.ID, "after")
		if s.Status != ExecutionSkipped || s.SkipReason != SkipWorkflowDeleted {
			t.Fatalf("after = %s %q", s.Status, s.SkipReason)
		}
		store.mu.Lock()
		row := store.executions[exec.ID]
		store.reopenLocked(scope, &row, now())
		store.executions[exec.ID] = row
		store.mu.Unlock()
		if s, _ := step(exec.ID, "after"); s.SkipReason != SkipWorkflowDeleted {
			t.Fatalf("reopened workflow_deleted: %s %q", s.Status, s.SkipReason)
		}
		if _, err := store.GetExecutionByID(ctx, scope, exec.ID); errors.Is(err, ErrNotFound) {
			t.Skip("run removed with workflow")
		}
	})
}

// TestPostgresSkipReasonBackfill runs the 000047 backfill function body on
// a seeded mix of pre-skip-reason rows (constraint dropped inside a
// rolled-back transaction) and asserts the reasons it assigns.
func TestPostgresSkipReasonBackfill(t *testing.T) {
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
	store := NewPostgres(app)
	ws, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(ws, userID)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := migrations.SQL.ReadFile("000047_step_skip_reason.sql")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	start := strings.Index(src, "CREATE OR REPLACE FUNCTION app.backfill_step_skip_reason()")
	if start < 0 {
		t.Fatal("backfill function not found in 000047")
	}
	end := strings.Index(src[start:], "\n$$;")
	if end < 0 {
		t.Fatal("backfill function end not found")
	}
	fn := src[start : start+end+4]

	failed := startGraph(t, ctx, store, scope, retryChainYAML)
	cascade := startGraph(t, ctx, store, scope, gateCascadeYAML)
	branch := startGraph(t, ctx, store, scope, retryChainYAML)
	canceled := startGraph(t, ctx, store, scope, retryChainYAML)
	legacy := startGraph(t, ctx, store, scope, retryChainYAML)

	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `ALTER TABLE execution_steps DROP CONSTRAINT execution_steps_skip_reason_iff_skipped`); err != nil {
		t.Fatal(err)
	}
	set := func(execID, node, status string) {
		t.Helper()
		if _, err := tx.Exec(ctx, `UPDATE execution_steps SET status = $3, skip_reason = NULL WHERE execution_id = $1::uuid AND node_id = $2`, execID, node, status); err != nil {
			t.Fatal(err)
		}
	}
	set(failed.ID, "seed", ExecutionFailed)
	set(failed.ID, "next", ExecutionSkipped)
	set(cascade.ID, "seed", ExecutionSucceeded)
	set(cascade.ID, "gate", ExecutionIndeterminate)
	set(cascade.ID, "after", ExecutionSkipped)
	set(cascade.ID, "tail", ExecutionSkipped)
	set(branch.ID, "seed", ExecutionSucceeded)
	set(branch.ID, "next", ExecutionSkipped)
	set(canceled.ID, "seed", ExecutionCanceled)
	set(canceled.ID, "next", ExecutionSkipped)
	set(legacy.ID, "seed", ExecutionCanceled)
	set(legacy.ID, "next", ExecutionCanceled)
	if _, err := tx.Exec(ctx, fn); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT app.backfill_step_skip_reason()`); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ exec, node, status, reason string }{
		{failed.ID, "next", ExecutionSkipped, SkipUpstreamFailed},
		{cascade.ID, "after", ExecutionSkipped, SkipUpstreamIndeterminate},
		{cascade.ID, "tail", ExecutionSkipped, SkipUpstreamIndeterminate},
		{branch.ID, "next", ExecutionSkipped, SkipBranchNotTaken},
		{canceled.ID, "next", ExecutionSkipped, SkipRunCanceled},
		{legacy.ID, "next", ExecutionCanceled, ""},
		{legacy.ID, "seed", ExecutionCanceled, ""},
	} {
		var status, reason string
		if err := tx.QueryRow(ctx, `SELECT status, COALESCE(skip_reason, '') FROM execution_steps WHERE execution_id = $1::uuid AND node_id = $2`, c.exec, c.node).Scan(&status, &reason); err != nil {
			t.Fatal(err)
		}
		if status != c.status || reason != c.reason {
			t.Fatalf("%s: %s %q, want %s %q", c.node, status, reason, c.status, c.reason)
		}
	}
	// The constraint re-adds cleanly over every backfilled row.
	if _, err := tx.Exec(ctx, `ALTER TABLE execution_steps ADD CONSTRAINT execution_steps_skip_reason_iff_skipped CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))`); err != nil {
		t.Fatalf("constraint after backfill: %v", err)
	}
}
