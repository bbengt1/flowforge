package approval

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/bbengt1/flowforge/apps/api/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresDeleteClosesParkedRuns(t *testing.T) {
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
	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, formatSlug("dk", suffix), "DK")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("du", suffix), "Delete")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("da", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }

	t.Run("parked gate is failed and frees the slot", func(t *testing.T) {
		scope, approver := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix)
		exec := publishRun(t, ctx, store, scope, gateThenStopSrc(suffix), "v1")
		completeSeed(t, ctx, store, scope, now)
		gate := claimStep(t, ctx, store, scope, now(), "gate")
		deadline := now().Add(time.Hour)
		parked, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
			JobID: gate.Job.ID, AvailableAt: deadline, Approval: parkedSeed(exec),
		})
		if err != nil {
			t.Fatal(err)
		}
		rec := onePending(t, ctx, approvals, scope, exec.ID)
		if rec.ExpiresAt.Sub(parked.Job.AvailableAt).Abs() > time.Millisecond {
			t.Fatalf("expires %s available %s", rec.ExpiresAt, parked.Job.AvailableAt)
		}
		impact, err := store.DeleteImpact(ctx, scope, exec.WorkflowID)
		if err != nil {
			t.Fatal(err)
		}
		if impact.WaitingRuns != 1 || impact.Blocked || impact.InFlightRuns != 0 {
			t.Fatalf("impact = %+v", impact)
		}
		other := publishVersion(t, ctx, store, scope, scriptSrc(suffix+1))
		if _, err := store.StartExecution(ctx, scope, other.WorkflowID, wfstore.StartInput{VersionID: other.ID, MaxOpen: 1}); !errors.Is(err, wfstore.ErrConcurrency) {
			t.Fatalf("slot before delete = %v", err)
		}
		if _, err := store.Delete(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatal(err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionFailed)
		assertStepJob(t, ctx, store, scope, exec.ID, "gate", wfstore.ExecutionCanceled, wfstore.JobCanceled)
		assertStepJob(t, ctx, store, scope, exec.ID, "after", wfstore.ExecutionCanceled, wfstore.JobCanceled)
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusCanceled || got.CloseReason != ReasonWorkflowDeleted || got.DecidedBy != "" {
			t.Fatalf("approval = %+v", got)
		}
		assertCloseEvent(t, ctx, approvals, scope, rec.ID, ReasonWorkflowDeleted)
		if _, err := approvals.Decide(ctx, approver, rec.ID, DecideInput{Decision: DecisionApproved, Now: now()}); !errors.Is(err, ErrClosed) {
			t.Fatalf("decide = %v", err)
		}
		steps, err := store.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range steps {
			if step.Status == wfstore.ExecutionCanceled && step.Error["code"] != wfstore.ReasonWorkflowDeleted {
				t.Fatalf("step %s error = %v", step.NodeID, step.Error)
			}
		}
		if _, err := store.Get(ctx, scope, exec.WorkflowID); !errors.Is(err, wfstore.ErrNotFound) {
			t.Fatalf("workflow = %v", err)
		}
		if _, err := store.StartExecution(ctx, scope, other.WorkflowID, wfstore.StartInput{VersionID: other.ID, MaxOpen: 1}); err != nil {
			t.Fatalf("slot after delete = %v", err)
		}
	})

	t.Run("queued sibling blocks and changes nothing", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix+2)
		exec := publishRun(t, ctx, store, scope, gateJoinSrc(suffix+2), "v1")
		completeSeed(t, ctx, store, scope, now)
		side := jobFor(t, ctx, store, scope, exec.ID, "side")
		if _, err := admin.Exec(ctx, `UPDATE execution_jobs SET status = 'blocked' WHERE id = $1::uuid`, side.ID); err != nil {
			t.Fatal(err)
		}
		gate := claimStep(t, ctx, store, scope, now(), "gate")
		deadline := now().Add(time.Hour)
		if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
			JobID: gate.Job.ID, AvailableAt: deadline, Approval: parkedSeed(exec),
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `UPDATE execution_jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL WHERE id = $1::uuid`, side.ID); err != nil {
			t.Fatal(err)
		}
		rec := onePending(t, ctx, approvals, scope, exec.ID)
		impact, err := store.DeleteImpact(ctx, scope, exec.WorkflowID)
		if err != nil {
			t.Fatal(err)
		}
		if !impact.Blocked || impact.InFlightRuns != 1 || impact.WaitingRuns != 0 {
			t.Fatalf("impact = %+v", impact)
		}
		if _, err := store.Delete(ctx, scope, exec.WorkflowID); !errors.Is(err, wfstore.ErrActiveExecutions) {
			t.Fatalf("delete = %v", err)
		}
		assertStepJob(t, ctx, store, scope, exec.ID, "gate", wfstore.ExecutionWaiting, wfstore.JobWaiting)
		assertStepJob(t, ctx, store, scope, exec.ID, "side", wfstore.ExecutionQueued, wfstore.JobQueued)
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusPending || got.DecidedBy != "" {
			t.Fatalf("approval = %+v", got)
		}
		if _, err := store.Get(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatalf("workflow changed: %v", err)
		}
	})

	t.Run("claimed sibling blocks and changes nothing", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix+3)
		exec := publishRun(t, ctx, store, scope, gateJoinSrc(suffix+3), "v1")
		completeSeed(t, ctx, store, scope, now)
		var gate wfstore.DispatchResult
		sawSide := false
		for i := 0; i < 2; i++ {
			got := claimStep(t, ctx, store, scope, now(), "")
			switch got.Step.NodeID {
			case "side":
				sawSide = true
			case "gate":
				gate = got
			default:
				t.Fatalf("claimed %s", got.Step.NodeID)
			}
		}
		if !sawSide || gate.Job.ID == "" {
			t.Fatal("sibling branch was not claimed")
		}
		deadline := now().Add(time.Hour)
		if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
			JobID: gate.Job.ID, AvailableAt: deadline, Approval: parkedSeed(exec),
		}); err != nil {
			t.Fatal(err)
		}
		impact, err := store.DeleteImpact(ctx, scope, exec.WorkflowID)
		if err != nil {
			t.Fatal(err)
		}
		if !impact.Blocked || impact.InFlightRuns != 1 || impact.WaitingRuns != 0 {
			t.Fatalf("impact = %+v", impact)
		}
		if _, err := store.Delete(ctx, scope, exec.WorkflowID); !errors.Is(err, wfstore.ErrActiveExecutions) {
			t.Fatalf("delete = %v", err)
		}
		assertStepJob(t, ctx, store, scope, exec.ID, "side", wfstore.ExecutionRunning, wfstore.JobClaimed)
		if _, err := store.Get(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatalf("workflow changed: %v", err)
		}
	})

	t.Run("queued and running jobs block", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix+4)
		queued := publishRun(t, ctx, store, scope, scriptSrc(suffix+4), "v1")
		impact, err := store.DeleteImpact(ctx, scope, queued.WorkflowID)
		if err != nil {
			t.Fatal(err)
		}
		if !impact.Blocked || impact.InFlightRuns != 1 || impact.WaitingRuns != 0 {
			t.Fatalf("queued impact = %+v", impact)
		}
		if _, err := store.Delete(ctx, scope, queued.WorkflowID); !errors.Is(err, wfstore.ErrActiveExecutions) {
			t.Fatalf("queued delete = %v", err)
		}
		running := publishRun(t, ctx, store, scope, scriptSrc(suffix+5), "v1")
		if _, err := admin.Exec(ctx, `
			UPDATE execution_jobs
			   SET available_at = now() + interval '1 hour'
			 WHERE execution_id = $1::uuid AND status = 'queued'
		`, queued.ID); err != nil {
			t.Fatal(err)
		}
		claimStep(t, ctx, store, scope, now(), "run")
		if _, err := admin.Exec(ctx, `
			UPDATE execution_jobs
			   SET available_at = now()
			 WHERE execution_id = $1::uuid AND status = 'queued'
		`, queued.ID); err != nil {
			t.Fatal(err)
		}
		impact, err = store.DeleteImpact(ctx, scope, running.WorkflowID)
		if err != nil {
			t.Fatal(err)
		}
		if !impact.Blocked || impact.InFlightRuns != 1 || impact.WaitingRuns != 0 {
			t.Fatalf("running impact = %+v", impact)
		}
		if _, err := store.Delete(ctx, scope, running.WorkflowID); !errors.Is(err, wfstore.ErrActiveExecutions) {
			t.Fatalf("running delete = %v", err)
		}
		assertStepJob(t, ctx, store, scope, running.ID, "run", wfstore.ExecutionRunning, wfstore.JobClaimed)
	})

	t.Run("parked delay is canceled and frees the slot", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix+6)
		exec := publishRun(t, ctx, store, scope, delaySrc(suffix+6), "v1")
		claimed := claimStep(t, ctx, store, scope, now(), "pause")
		deadline := now().Add(5 * time.Minute)
		parked, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{JobID: claimed.Job.ID, AvailableAt: deadline})
		if err != nil {
			t.Fatal(err)
		}
		if parked.Job.Status != wfstore.JobWaiting || parked.Job.AvailableAt.Sub(deadline).Abs() > time.Millisecond {
			t.Fatalf("timer status=%s available=%s deadline=%s", parked.Job.Status, parked.Job.AvailableAt, deadline)
		}
		other := publishVersion(t, ctx, store, scope, scriptSrc(suffix+7))
		if _, err := store.StartExecution(ctx, scope, other.WorkflowID, wfstore.StartInput{VersionID: other.ID, MaxOpen: 1}); !errors.Is(err, wfstore.ErrConcurrency) {
			t.Fatalf("slot before delete = %v", err)
		}
		impact, err := store.DeleteImpact(ctx, scope, exec.WorkflowID)
		if err != nil {
			t.Fatal(err)
		}
		if impact.WaitingRuns != 1 || impact.Blocked || impact.InFlightRuns != 0 {
			t.Fatalf("impact = %+v", impact)
		}
		if _, err := store.Delete(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatal(err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionFailed)
		assertStepJob(t, ctx, store, scope, exec.ID, "pause", wfstore.ExecutionCanceled, wfstore.JobCanceled)
		if _, err := store.StartExecution(ctx, scope, other.WorkflowID, wfstore.StartInput{VersionID: other.ID, MaxOpen: 1}); err != nil {
			t.Fatalf("slot after delete = %v", err)
		}
	})

	t.Run("delete races approve", func(t *testing.T) {
		scope, approver := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix+20)
		for i := 0; i < 4; i++ {
			exec := publishRun(t, ctx, store, scope, gateThenStopSrc(suffix+int64(20+i)), "v1")
			completeSeed(t, ctx, store, scope, now)
			gate := claimStep(t, ctx, store, scope, now(), "gate")
			deadline := now().Add(time.Hour)
			if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
				JobID: gate.Job.ID, AvailableAt: deadline, Approval: parkedSeed(exec),
			}); err != nil {
				t.Fatal(err)
			}
			rec := onePending(t, ctx, approvals, scope, exec.ID)
			var decideErr, deleteErr error
			assertNoDeadlock(t, func() error {
				_, decideErr = approvals.Decide(ctx, approver, rec.ID, DecideInput{
					Decision: DecisionApproved, Now: now(), Roles: []string{"approver"},
					Resolve: func(context.Context, isolation.Scope, Record) (policy.Requirement, error) {
						return StoredRequirement(rec), nil
					},
				})
				return decideErr
			}, func() error {
				_, deleteErr = store.Delete(ctx, scope, exec.WorkflowID)
				return deleteErr
			})
			if deleteErr != nil {
				t.Fatalf("delete = %v", deleteErr)
			}
			assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionFailed)
			got, err := approvals.Get(ctx, scope, rec.ID)
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case decideErr == nil:
				if got.Status != StatusApproved || got.CloseReason != "" || got.DecidedBy == "" {
					t.Fatalf("decision won but approval = %+v", got)
				}
			case errors.Is(decideErr, ErrClosed):
				if got.Status != StatusCanceled || got.CloseReason != ReasonWorkflowDeleted || got.DecidedBy != "" {
					t.Fatalf("delete won but approval = %+v", got)
				}
			default:
				t.Fatalf("decide = %v", decideErr)
			}
			events, err := approvals.Events(ctx, scope, rec.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, ev := range events {
				if ev.EventType == EventApproved && got.Status != StatusApproved {
					t.Fatalf("approved event on %s", got.Status)
				}
			}
		}
	})
}

func TestPostgresSettleStuckRuns(t *testing.T) {
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
	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, formatSlug("sk", suffix), "SK")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("su", suffix), "Settle")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }
	raw, err := migrations.SQL.ReadFile("000036_settle_stuck_runs.sql")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("legacy rejected gate rolls up and frees the slot", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, user.ID, suffix+40)
		ver := publishVersion(t, ctx, store, scope, gateThenStopSrc(suffix))
		execID := insertRejectedRunning(t, ctx, admin, scope.WorkspaceID(), user.ID, ver)
		other := publishVersion(t, ctx, store, scope, scriptSrc(suffix+1))
		if _, err := store.StartExecution(ctx, scope, other.WorkflowID, wfstore.StartInput{VersionID: other.ID, MaxOpen: 1}); !errors.Is(err, wfstore.ErrConcurrency) {
			t.Fatalf("slot before backfill = %v", err)
		}
		if _, err := admin.Exec(ctx, `SELECT app.backfill_settle_stuck_runs()`); err != nil {
			t.Fatal(err)
		}
		assertExec(t, ctx, store, scope, execID, wfstore.ExecutionSucceeded)
		if _, err := store.StartExecution(ctx, scope, other.WorkflowID, wfstore.StartInput{VersionID: other.ID, MaxOpen: 1}); err != nil {
			t.Fatalf("slot after backfill = %v", err)
		}
		if _, err := admin.Exec(ctx, `SELECT app.backfill_settle_stuck_runs()`); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("re-run 000036: %v", err)
		}
		assertExec(t, ctx, store, scope, execID, wfstore.ExecutionSucceeded)
	})

	t.Run("deleted workflow waiting approval is failed", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, user.ID, suffix+42)
		exec := publishRun(t, ctx, store, scope, gateThenStopSrc(suffix+2), "v1")
		completeSeed(t, ctx, store, scope, now)
		gate := claimStep(t, ctx, store, scope, now(), "gate")
		deadline := now().Add(time.Hour)
		if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
			JobID: gate.Job.ID, AvailableAt: deadline, Approval: parkedSeed(exec),
		}); err != nil {
			t.Fatal(err)
		}
		rec := onePending(t, ctx, approvals, scope, exec.ID)
		if _, err := admin.Exec(ctx, `
			UPDATE workflows SET status = 'draft', deleted_at = now(), updated_at = now() WHERE id = $1::uuid
		`, exec.WorkflowID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `SELECT app.backfill_settle_stuck_runs()`); err != nil {
			t.Fatal(err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionFailed)
		assertStepJob(t, ctx, store, scope, exec.ID, "gate", wfstore.ExecutionCanceled, wfstore.JobCanceled)
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusCanceled || got.CloseReason != ReasonWorkflowDeleted || got.DecidedBy != "" {
			t.Fatalf("approval = %+v", got)
		}
		if _, err := admin.Exec(ctx, `SELECT app.backfill_settle_stuck_runs()`); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("approval follows a gate that already left waiting", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, user.ID, suffix+43)
		exec := publishRun(t, ctx, store, scope, gateThenStopSrc(suffix+3), "v1")
		completeSeed(t, ctx, store, scope, now)
		gate := claimStep(t, ctx, store, scope, now(), "gate")
		deadline := now().Add(time.Hour)
		if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
			JobID: gate.Job.ID, AvailableAt: deadline, Approval: parkedSeed(exec),
		}); err != nil {
			t.Fatal(err)
		}
		rec := onePending(t, ctx, approvals, scope, exec.ID)
		if _, err := admin.Exec(ctx, `UPDATE execution_jobs SET status = 'succeeded', updated_at = now() WHERE execution_id = $1::uuid AND status = 'waiting'`, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `
			UPDATE execution_steps
			   SET status = 'succeeded',
			       output_redacted = '{"port":"expired","decision":"expired"}'::jsonb,
			       finished_at = now(), updated_at = now()
			 WHERE execution_id = $1::uuid AND node_type = 'flow.approval'
		`, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `UPDATE executions SET status = 'succeeded', finished_at = now(), updated_at = now() WHERE id = $1::uuid`, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `SELECT app.backfill_settle_stuck_runs()`); err != nil {
			t.Fatal(err)
		}
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusExpired || got.CloseReason != "" || got.DecidedBy != "" {
			t.Fatalf("approval = %+v", got)
		}
		if n := countEvent(t, ctx, approvals, scope, rec.ID, EventExpired); n != 1 {
			t.Fatalf("expired events = %d", n)
		}
		if _, err := admin.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("re-run 000036: %v", err)
		}
		if n := countEvent(t, ctx, approvals, scope, rec.ID, EventExpired); n != 1 {
			t.Fatalf("expired events after re-run = %d", n)
		}
	})
}

func desk(t *testing.T, ctx context.Context, ids *identity.Postgres, tenantID, ownerID, approverID string, n int64) (isolation.Scope, isolation.Scope) {
	t.Helper()
	ws, err := ids.CreateWorkspace(ctx, tenantID, formatSlug("desk", n), "Desk", ownerID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	approver, err := isolation.Authorize(ws.ID, approverID)
	if err != nil {
		t.Fatal(err)
	}
	return scope, approver
}

func parkedSeed(exec wfstore.Execution) *wfstore.ParkedApproval {
	return &wfstore.ParkedApproval{
		WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
		ExecutionID: exec.ID, RequestedBy: exec.RequestedBy,
		NodeID: "gate", NodeName: "Gate", Operation: "flow.approval", ApproverRole: "approver",
	}
}

func onePending(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, executionID string) Record {
	t.Helper()
	items, err := store.List(ctx, scope, Filter{Status: StatusPending, ExecutionID: executionID})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("pending = %d", len(items))
	}
	return items[0]
}

func assertCloseEvent(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, approvalID, reason string) {
	t.Helper()
	events, err := store.Events(ctx, scope, approvalID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.EventType != EventCanceled {
			continue
		}
		if ev.ActorID != "" || ev.Details["reason"] != reason || len(ev.Details) != 1 {
			t.Fatalf("event = %+v", ev)
		}
		return
	}
	t.Fatal("missing canceled event")
}

func countEvent(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, approvalID, eventType string) int {
	t.Helper()
	events, err := store.Events(ctx, scope, approvalID)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, ev := range events {
		if ev.EventType == eventType {
			n++
		}
	}
	return n
}

func publishRun(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, src, note string) wfstore.Execution {
	t.Helper()
	ver := publishVersion(t, ctx, store, scope, src)
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	_ = note
	return exec
}

func publishVersion(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, src string) wfstore.Version {
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
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	return ver
}

func completeSeed(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, now func() time.Time) {
	t.Helper()
	seed := claimStep(t, ctx, store, scope, now(), "seed")
	if _, err := store.CompleteJob(ctx, scope, now(), wfstore.JobActionInput{
		JobID: seed.Job.ID, WorkerID: "edge-worker", FencingToken: seed.Job.FencingToken,
		Output: map[string]any{"result": map[string]any{"ticket": "CHG-1"}},
	}); err != nil {
		t.Fatal(err)
	}
}

func claimStep(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, now time.Time, node string) wfstore.DispatchResult {
	t.Helper()
	got, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if node != "" && got.Step.NodeID != node {
		t.Fatalf("claimed %s, want %s", got.Step.NodeID, node)
	}
	return got
}

func assertExec(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID, status string) {
	t.Helper()
	got, err := store.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != status {
		t.Fatalf("run = %s, want %s", got.Status, status)
	}
}

func assertStepJob(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID, node, stepStatus, jobStatus string) {
	t.Helper()
	step, job := stepAndJob(t, ctx, store, scope, executionID, node)
	if step.Status != stepStatus || job.Status != jobStatus {
		t.Fatalf("%s step=%s job=%s, want %s/%s", node, step.Status, job.Status, stepStatus, jobStatus)
	}
}

func jobFor(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID, node string) wfstore.ExecutionJob {
	t.Helper()
	_, job := stepAndJob(t, ctx, store, scope, executionID, node)
	return job
}

func stepAndJob(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID, node string) (wfstore.ExecutionStep, wfstore.ExecutionJob) {
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

func insertRejectedRunning(t *testing.T, ctx context.Context, admin *pgxpool.Pool, ws, userID string, ver wfstore.Version) string {
	t.Helper()
	var execID string
	if err := admin.QueryRow(ctx, `
		INSERT INTO executions (
			workspace_id, workflow_id, workflow_version_id, workflow_digest, status, requested_by
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'running', $5::uuid)
		RETURNING id::text
	`, ws, ver.WorkflowID, ver.ID, ver.Digest, userID).Scan(&execID); err != nil {
		t.Fatal(err)
	}
	insertStep := func(node, typ string, attempt int, status, output string) string {
		t.Helper()
		var id string
		if err := admin.QueryRow(ctx, `
			INSERT INTO execution_steps (
				workspace_id, execution_id, node_id, node_type, attempt, status, output_redacted
			) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)
			RETURNING id::text
		`, ws, execID, node, typ, attempt, status, output).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	insertJob := func(stepID, status string, attempt int) {
		t.Helper()
		if _, err := admin.Exec(ctx, `
			INSERT INTO execution_jobs (
				workspace_id, execution_id, execution_step_id, status, available_at, attempt
			) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now(), $5)
		`, ws, execID, stepID, status, attempt); err != nil {
			t.Fatal(err)
		}
	}
	oldGate := insertStep("gate", "flow.approval", 1, wfstore.ExecutionFailed, `{"port":"rejected"}`)
	insertJob(oldGate, wfstore.JobFailed, 1)
	gate := insertStep("gate", "flow.approval", 2, wfstore.ExecutionSucceeded, `{"port":"rejected","decision":"rejected"}`)
	insertJob(gate, wfstore.JobSucceeded, 2)
	after := insertStep("after", "flow.stop", 1, wfstore.ExecutionSkipped, `{}`)
	insertJob(after, wfstore.JobSkipped, 1)
	return execID
}

func gateThenStopSrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: gate-then-stop-` + formatSlug("g", n) + `
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
}

func gateJoinSrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: gate-join-` + formatSlug("j", n) + `
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
}

func scriptSrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: script-` + formatSlug("s", n) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: data.set
      name: Run
      with:
        value:
          ticket: CHG-1
  edges: []
`
}

func delaySrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: delay-` + formatSlug("d", n) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Pause
      with:
        duration: PT5M
  edges: []
`
}
