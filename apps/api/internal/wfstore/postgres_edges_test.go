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
	"github.com/jackc/pgx/v5/pgxpool"
)

const sshThenStopYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ssh-then-stop
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: ssh.run
      name: Run
      with:
        sshTargetId: 11111111-1111-4111-8111-111111111111
        commandProfileId: 22222222-2222-4222-8222-222222222222
    - id: next
      type: flow.stop
      name: Next
      with:
        status: success
  edges:
    - from: run.stdout
      to: next.input
`

const gateThenStopYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: gate-then-stop
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
    - id: after
      type: flow.stop
      name: After
      with:
        status: success
  edges:
    - from: seed.result
      to: gate.request
    - from: gate.approved
      to: after.input
`

const gateJoinYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: gate-join
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
    - id: side
      type: flow.condition
      name: Side
      with:
        op: exists
    - id: join
      type: kubernetes.apply
      name: Join
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: demo
  edges:
    - from: seed.result
      to: gate.request
    - from: seed.result
      to: side.value
    - from: gate.approved
      to: join.parameters
    - from: side.true
      to: join.manifests
`

const gateCascadeYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: gate-cascade
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
    - id: after
      type: flow.stop
      name: After
      with:
        status: success
    - id: tail
      type: flow.stop
      name: Tail
      with:
        status: success
  edges:
    - from: seed.result
      to: gate.request
    - from: gate.approved
      to: after.input
    - from: after.result
      to: tail.input
`

const conditionJoinYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: condition-join
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
          ready: true
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: exists
    - id: join
      type: kubernetes.apply
      name: Join
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: demo
  edges:
    - from: seed.result
      to: gate.value
    - from: gate.true
      to: join.manifests
    - from: gate.false
      to: join.parameters
`

const conditionOrJoinYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: condition-or-join
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
          ready: true
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: exists
    - id: join
      type: kubernetes.apply
      name: Join
      join: any
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: demo
  edges:
    - from: seed.result
      to: gate.value
    - from: gate.true
      to: join.manifests
    - from: gate.false
      to: join.parameters
`

const retryChainYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: retry-chain
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
    - id: next
      type: flow.stop
      name: Next
      with:
        status: success
  edges:
    - from: seed.result
      to: next.input
`

func TestPostgresUpstreamEdges(t *testing.T) {
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
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }

	t.Run("approval holds then runs or skips", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateThenStopYAML)
		steps := listSteps(t, ctx, store, scope, exec.ID)
		jobs := listJobs(t, ctx, store, scope, exec.ID)
		afterStep := stepByNode(t, steps, "after")
		afterJob := jobByNode(t, jobs, steps, "after")
		if afterStep.Status != ExecutionPending || afterStep.UnresolvedIncoming != 1 || afterJob.Status != JobBlocked {
			t.Fatalf("after step=%s unresolved=%d job=%s", afterStep.Status, afterStep.UnresolvedIncoming, afterJob.Status)
		}
		if _, err := admin.Exec(ctx, `UPDATE execution_jobs SET status = 'queued' WHERE id = $1::uuid`, afterJob.ID); err != nil {
			t.Fatal(err)
		}
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := admin.Exec(ctx, `UPDATE execution_jobs SET status = 'blocked' WHERE id = $1::uuid`, afterJob.ID); err != nil {
			t.Fatal(err)
		}
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.ClaimJob(ctx, scope, now(), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("downstream claim while gate is claimed: %v", err)
		}
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gateClaim.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ClaimJob(ctx, scope, now(), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("downstream claim while gate waits: %v", err)
		}
		if _, err := store.ResumeWait(ctx, scope, now(), ResumeWaitInput{JobID: gateClaim.Job.ID, Port: "approved"}); err != nil {
			t.Fatal(err)
		}
		afterClaim := claimNode(t, ctx, store, scope, now(), "after")
		completeJob(t, ctx, store, scope, now(), afterClaim, map[string]any{"result": map[string]any{"status": "success"}})
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("rejection skips downstream and finishes", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateThenStopYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gateClaim.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ResumeWait(ctx, scope, now(), ResumeWaitInput{JobID: gateClaim.Job.ID, Port: "rejected"}); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "after", ExecutionSkipped, JobSkipped)
		if _, err := store.ClaimJob(ctx, scope, now(), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("skipped step was claimable: %v", err)
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("expiry skips downstream and finishes", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateThenStopYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gateClaim.Job.ID, AvailableAt: now().Add(-time.Second)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RecoverExpiredLeases(ctx, scope, now()); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "after", ExecutionSkipped, JobSkipped)
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("rejected gate skips a two-input join", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateJoinYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		var gateClaim DispatchResult
		sawSide := false
		for i := 0; i < 2; i++ {
			got := claimNode(t, ctx, store, scope, now(), "")
			switch got.Step.NodeID {
			case "side":
				completeJob(t, ctx, store, scope, now(), got, map[string]any{"true": map[string]any{"ok": true}})
				sawSide = true
			case "gate":
				gateClaim = got
			default:
				t.Fatalf("claimed %s", got.Step.NodeID)
			}
		}
		if !sawSide || gateClaim.Job.ID == "" {
			t.Fatal("join inputs were not both claimed")
		}
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gateClaim.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ResumeWait(ctx, scope, now(), ResumeWaitInput{JobID: gateClaim.Job.ID, Port: "rejected"}); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "join", ExecutionSkipped, JobSkipped)
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("default AND join after if else is skipped", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, conditionJoinYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ready": true}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		completeJob(t, ctx, store, scope, now(), gateClaim, map[string]any{"port": "true", "true": map[string]any{"ready": true}})
		assertNode(t, ctx, store, scope, exec.ID, "join", ExecutionSkipped, JobSkipped)
		if _, err := store.ClaimJob(ctx, scope, now(), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("AND join was claimable: %v", err)
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("explicit OR join after if else runs when one branch is satisfied", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, conditionOrJoinYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ready": true}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		completeJob(t, ctx, store, scope, now(), gateClaim, map[string]any{"port": "true", "true": map[string]any{"ready": true}})
		joinClaim := claimNode(t, ctx, store, scope, now(), "join")
		if joinClaim.Step.Status != ExecutionRunning && joinClaim.Step.Status != ExecutionQueued {
			t.Fatalf("OR join step=%s", joinClaim.Step.Status)
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("skip cascades", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, gateCascadeYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), seedClaim, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gateClaim := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gateClaim.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ResumeWait(ctx, scope, now(), ResumeWaitInput{JobID: gateClaim.Job.ID, Port: "rejected"}); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "after", ExecutionSkipped, JobSkipped)
		assertNode(t, ctx, store, scope, exec.ID, "tail", ExecutionSkipped, JobSkipped)
		assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
	})

	t.Run("retry releases downstream once", func(t *testing.T) {
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
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionPending, JobBlocked)
		again := claimNode(t, ctx, store, scope, now(), "seed")
		if again.Step.ID != retried.Step.ID {
			t.Fatalf("claimed attempt %s want %s", again.Step.ID, retried.Step.ID)
		}
		completeJob(t, ctx, store, scope, now(), again, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		if n := countNodeJobs(t, ctx, store, scope, exec.ID, "next"); n != 1 {
			t.Fatalf("downstream jobs=%d", n)
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionQueued, JobQueued)
		if _, err := store.CompleteJob(ctx, scope, now(), JobActionInput{
			JobID: again.Job.ID, WorkerID: "edge-worker", FencingToken: again.Job.FencingToken,
			Output: map[string]any{"result": map[string]any{"ticket": "CHG-1"}},
		}); err != nil {
			t.Fatal(err)
		}
		if n := countNodeJobs(t, ctx, store, scope, exec.ID, "next"); n != 1 {
			t.Fatalf("second complete jobs=%d", n)
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionQueued, JobQueued)
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("release requeue does not release downstream", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, retryChainYAML)
		seedClaim := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := store.ReleaseJob(ctx, scope, now(), JobActionInput{
			JobID: seedClaim.Job.ID, WorkerID: "edge-worker", FencingToken: seedClaim.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionPending, JobBlocked)
		again := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), again, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		if n := countNodeJobs(t, ctx, store, scope, exec.ID, "next"); n != 1 {
			t.Fatalf("downstream jobs=%d", n)
		}
		assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionQueued, JobQueued)
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("in-flight backfill keeps a parked gate's downstream blocked", func(t *testing.T) {
		wf, ver := publishOnly(t, ctx, store, scope, gateThenStopYAML)
		execID := insertLegacyRun(t, ctx, admin, ws, userID, wf.ID, ver, false)
		claimedID := insertLegacyRun(t, ctx, admin, ws, userID, wf.ID, ver, true)
		if _, err := admin.Exec(ctx, `SELECT app.backfill_execution_dependencies()`); err != nil {
			t.Fatal(err)
		}
		assertNode(t, ctx, store, scope, execID, "after", ExecutionPending, JobBlocked)
		assertNode(t, ctx, store, scope, execID, "gate", ExecutionWaiting, JobWaiting)
		if _, err := store.ClaimJob(ctx, scope, now(), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("backfilled downstream was claimable: %v", err)
		}
		steps := listSteps(t, ctx, store, scope, claimedID)
		jobs := listJobs(t, ctx, store, scope, claimedID)
		if job := jobByNode(t, jobs, steps, "after"); job.Status != JobClaimed {
			t.Fatalf("already claimed downstream = %s", job.Status)
		}
	})

	t.Run("ssh.run empty or null stdout releases downstream", func(t *testing.T) {
		for _, output := range []map[string]any{
			{"stdout": "", "result": map[string]any{}, "exitCode": 0},
			{"stdout": nil, "result": nil, "exitCode": nil},
		} {
			exec := startGraph(t, ctx, store, scope, sshThenStopYAML)
			claimed := claimNode(t, ctx, store, scope, now(), "run")
			completeJob(t, ctx, store, scope, now(), claimed, output)
			assertNode(t, ctx, store, scope, exec.ID, "next", ExecutionQueued, JobQueued)
			next := claimNode(t, ctx, store, scope, now(), "next")
			completeJob(t, ctx, store, scope, now(), next, map[string]any{"result": map[string]any{"status": "success"}})
			assertRun(t, ctx, store, scope, exec.ID, ExecutionSucceeded)
		}
	})
}

func startGraph(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, src string) Execution {
	t.Helper()
	_, ver := publishOnly(t, ctx, store, scope, src)
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return exec
}

func publishOnly(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, src string) (Workflow, Version) {
	t.Helper()
	src = strings.Replace(src, "\n  name: ", "\n  name: n"+strconv.FormatInt(time.Now().UnixNano(), 36)+"-", 1)
	normalized := mustNormalize(t, src)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "edges"})
	if err != nil {
		t.Fatal(err)
	}
	return wf, ver
}

func listSteps(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, executionID string) []ExecutionStep {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	return steps
}

func listJobs(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, executionID string) []ExecutionJob {
	t.Helper()
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	return jobs
}

func stepByNode(t *testing.T, steps []ExecutionStep, node string) ExecutionStep {
	t.Helper()
	var found ExecutionStep
	for _, step := range steps {
		if step.NodeID == node && step.Attempt >= found.Attempt {
			found = step
		}
	}
	if found.ID == "" {
		t.Fatalf("missing step %s", node)
	}
	return found
}

func jobByNode(t *testing.T, jobs []ExecutionJob, steps []ExecutionStep, node string) ExecutionJob {
	t.Helper()
	step := stepByNode(t, steps, node)
	for _, job := range jobs {
		if job.ExecutionStepID == step.ID {
			return job
		}
	}
	t.Fatalf("missing job %s", node)
	return ExecutionJob{}
}

func claimNode(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, now time.Time, node string) DispatchResult {
	t.Helper()
	got, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if node != "" && got.Step.NodeID != node {
		t.Fatalf("claimed %s, want %s", got.Step.NodeID, node)
	}
	return got
}

func completeJob(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, now time.Time, claimed DispatchResult, output map[string]any) {
	t.Helper()
	if _, err := store.CompleteJob(ctx, scope, now, JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken, Output: output,
	}); err != nil {
		t.Fatal(err)
	}
}

func assertNode(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, executionID, node, stepStatus, jobStatus string) {
	t.Helper()
	steps := listSteps(t, ctx, store, scope, executionID)
	jobs := listJobs(t, ctx, store, scope, executionID)
	step := stepByNode(t, steps, node)
	job := jobByNode(t, jobs, steps, node)
	if step.Status != stepStatus || job.Status != jobStatus {
		t.Fatalf("%s step=%s job=%s, want %s/%s", node, step.Status, job.Status, stepStatus, jobStatus)
	}
}

func assertRun(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, executionID, status string) {
	t.Helper()
	got, err := store.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != status {
		t.Fatalf("run status=%s, want %s", got.Status, status)
	}
}

func countNodeJobs(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, executionID, node string) int {
	t.Helper()
	steps := listSteps(t, ctx, store, scope, executionID)
	jobs := listJobs(t, ctx, store, scope, executionID)
	n := 0
	for _, step := range steps {
		if step.NodeID != node {
			continue
		}
		for _, job := range jobs {
			if job.ExecutionStepID == step.ID {
				n++
			}
		}
	}
	return n
}

func insertLegacyRun(t *testing.T, ctx context.Context, admin *pgxpool.Pool, ws, userID, workflowID string, ver Version, claimAfter bool) string {
	t.Helper()
	var execID string
	if err := admin.QueryRow(ctx, `
		INSERT INTO executions (
			workspace_id, workflow_id, workflow_version_id, workflow_digest, status, requested_by
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'waiting', $5::uuid)
		RETURNING id::text
	`, ws, workflowID, ver.ID, ver.Digest, userID).Scan(&execID); err != nil {
		t.Fatal(err)
	}
	insertLegacyStep := func(node, typ, status, output string) string {
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
	seedID := insertLegacyStep("seed", "data.set", ExecutionSucceeded, `{"result":{"ticket":"CHG-1"}}`)
	gateID := insertLegacyStep("gate", "flow.approval", ExecutionWaiting, `{}`)
	afterStatus := ExecutionQueued
	if claimAfter {
		afterStatus = ExecutionRunning
	}
	afterID := insertLegacyStep("after", "flow.stop", afterStatus, `{}`)
	insertLegacyJob := func(stepID, status, worker string) {
		t.Helper()
		if _, err := admin.Exec(ctx, `
			INSERT INTO execution_jobs (
				workspace_id, execution_id, execution_step_id, status, available_at, worker_id, lease_expires_at, attempt
			) VALUES (
				$1::uuid, $2::uuid, $3::uuid, $4,
				CASE WHEN $4 = 'waiting' THEN now() + interval '1 day' ELSE now() END,
				NULLIF($5, ''),
				CASE WHEN $4 = 'claimed' THEN now() + interval '1 hour' ELSE NULL END,
				1
			)
		`, ws, execID, stepID, status, worker); err != nil {
			t.Fatal(err)
		}
	}
	insertLegacyJob(seedID, JobSucceeded, "")
	insertLegacyJob(gateID, JobWaiting, "")
	if claimAfter {
		insertLegacyJob(afterID, JobClaimed, "legacy-worker")
	} else {
		insertLegacyJob(afterID, JobQueued, "")
	}
	return execID
}
