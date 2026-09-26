package approval

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresResyncCorrectsClosesAndFreesSlot(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("rs", suffix), "RS")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("ru", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("ra", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }
	scope, approver := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix)

	exec := publishRun(t, ctx, store, scope, adminGateSrc(suffix), "v1")
	gate := claimStep(t, ctx, store, scope, now(), "gate")
	if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
		JobID: gate.Job.ID, AvailableAt: now().Add(time.Hour),
		Approval: &wfstore.ParkedApproval{
			WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
			ExecutionID: exec.ID, RequestedBy: exec.RequestedBy,
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval", ApproverRole: "approver",
		},
	}); err != nil {
		t.Fatal(err)
	}
	rec := onePending(t, ctx, approvals, scope, exec.ID)
	stats, err := resyncWorkspace(ctx, app, store, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || stats.Corrected != 1 || stats.Closed != 0 {
		t.Fatalf("stats = %+v %v", stats, err)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.ApproverRole != "admin" || got.Status != StatusPending {
		t.Fatalf("corrected = %+v %v", got, err)
	}
	events, err := approvals.Events(ctx, scope, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	from, to := correctedPair(t, events, "approverRole")
	if from != "approver" || to != "admin" {
		t.Fatalf("correction = %s -> %s", from, to)
	}
	hidden, err := approvals.List(ctx, approver, Filter{
		Status: StatusPending, ExecutionID: exec.ID, Actionable: true,
		ActorID: approver.ActorID(), ActorRoles: []string{"approver"},
	})
	if err != nil || len(hidden) != 0 {
		t.Fatalf("approver pending = %+v %v", hidden, err)
	}
	visible, err := approvals.List(ctx, scope, Filter{
		Status: StatusPending, ExecutionID: exec.ID, Actionable: true,
		ActorID: scope.ActorID(), ActorRoles: []string{"admin"},
	})
	if err != nil || len(visible) != 1 || visible[0].ID != rec.ID {
		t.Fatalf("admin pending = %+v %v", visible, err)
	}
	again, err := resyncWorkspace(ctx, app, store, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || again.Corrected != 0 || again.Closed != 0 {
		t.Fatalf("second = %+v %v", again, err)
	}
	still := onePending(t, ctx, approvals, scope, exec.ID)
	if !still.UpdatedAt.Equal(got.UpdatedAt) || still.BindingFingerprint != got.BindingFingerprint {
		t.Fatalf("second pass changed %+v", still)
	}

	exec2 := publishRun(t, ctx, store, scope, expiredDownstreamSrc(suffix+1), "v1")
	gate2 := claimStep(t, ctx, store, scope, now(), "gate")
	if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
		JobID: gate2.Job.ID, AvailableAt: now().Add(time.Hour),
		Approval: parkedSeed(exec2),
	}); err != nil {
		t.Fatal(err)
	}
	stale := onePending(t, ctx, approvals, scope, exec2.ID)
	wf, err := store.Get(ctx, scope, exec2.WorkflowID)
	if err != nil {
		t.Fatal(err)
	}
	parsed, errs := workflow.ParseAndNormalize([]byte(stopOnlySrc(suffix + 1)))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	if _, _, err := store.SaveDraft(ctx, scope, exec2.WorkflowID, wfstore.SaveInput{
		ExpectedRevision: wf.DraftRevision, NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary,
	}); err != nil {
		t.Fatal(err)
	}
	wf, err = store.Get(ctx, scope, exec2.WorkflowID)
	if err != nil {
		t.Fatal(err)
	}
	_, next, err := store.Publish(ctx, scope, exec2.WorkflowID, wfstore.PublishInput{ExpectedRevision: wf.DraftRevision, Note: "v2"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := postgres.BeginScoped(ctx, app, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE approvals SET workflow_version_id = $2::uuid WHERE id = $1::uuid`, stale.ID, next.ID); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	closedStats, err := resyncWorkspace(ctx, app, store, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || closedStats.Closed != 1 || closedStats.Corrected != 0 {
		t.Fatalf("close stats = %+v %v", closedStats, err)
	}
	closed, err := approvals.Get(ctx, scope, stale.ID)
	if err != nil || closed.Status != StatusCanceled || closed.CloseReason != ReasonRequirementUnresolvable || closed.DecidedBy != "" {
		t.Fatalf("closed = %+v %v", closed, err)
	}
	assertExec(t, ctx, store, scope, exec2.ID, wfstore.ExecutionFailed)
	gateStep, gateJob := stepAndJob(t, ctx, store, scope, exec2.ID, "gate")
	if gateStep.Status != wfstore.ExecutionFailed || gateJob.Status != wfstore.JobFailed {
		t.Fatalf("gate step=%s job=%s", gateStep.Status, gateJob.Status)
	}
	if code, _ := gateStep.Error["code"].(string); code != wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("gate error = %+v", gateStep.Error)
	}
	if port, _ := gateStep.Output["port"].(string); port == "expired" {
		t.Fatalf("gate took expired port: %+v", gateStep.Output)
	}
	lateStep, lateJob := stepAndJob(t, ctx, store, scope, exec2.ID, "late")
	if lateStep.Status != wfstore.ExecutionPending || lateJob.Status != wfstore.JobBlocked || lateStep.StartedAt != nil {
		t.Fatalf("late step=%s job=%s started=%v", lateStep.Status, lateJob.Status, lateStep.StartedAt)
	}
	if code, _ := lateStep.Error["code"].(string); code != "" {
		t.Fatalf("late error = %+v", lateStep.Error)
	}
	if port, _ := lateStep.Output["port"].(string); port != "" {
		t.Fatalf("late ran: %+v", lateStep.Output)
	}
	var active int
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM executions
		 WHERE id = $1 AND status IN ('queued', 'running', 'waiting')
	`, exec2.ID).Scan(&active); err != nil || active != 0 {
		t.Fatalf("slot still held: %d %v", active, err)
	}
	assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
	third, err := resyncWorkspace(ctx, app, store, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || third.Closed != 0 || third.Corrected != 0 {
		t.Fatalf("third = %+v %v", third, err)
	}
	stillLate, stillLateJob := stepAndJob(t, ctx, store, scope, exec2.ID, "late")
	if stillLate.Status != wfstore.ExecutionPending || stillLateJob.Status != wfstore.JobBlocked {
		t.Fatalf("second pass released late step=%s job=%s", stillLate.Status, stillLateJob.Status)
	}
}

func TestPostgresResyncRollsUpAfterSiblingFinishes(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("sb", suffix), "SB")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("su", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("sa", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }
	scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix)
	exec := publishRun(t, ctx, store, scope, siblingGateSrc(suffix), "v1")
	side := parkGateHoldSibling(t, ctx, store, scope, now(), exec)
	stale := onePending(t, ctx, approvals, scope, exec.ID)
	wf, err := store.Get(ctx, scope, exec.WorkflowID)
	if err != nil {
		t.Fatal(err)
	}
	parsed, errs := workflow.ParseAndNormalize([]byte(stopOnlySrc(suffix)))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	if _, _, err := store.SaveDraft(ctx, scope, exec.WorkflowID, wfstore.SaveInput{
		ExpectedRevision: wf.DraftRevision, NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary,
	}); err != nil {
		t.Fatal(err)
	}
	wf, err = store.Get(ctx, scope, exec.WorkflowID)
	if err != nil {
		t.Fatal(err)
	}
	_, next, err := store.Publish(ctx, scope, exec.WorkflowID, wfstore.PublishInput{ExpectedRevision: wf.DraftRevision, Note: "v2"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := postgres.BeginScoped(ctx, app, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE approvals SET workflow_version_id = $2::uuid WHERE id = $1::uuid`, stale.ID, next.ID); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	closedStats, err := resyncWorkspace(ctx, app, store, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || closedStats.Closed != 1 {
		t.Fatalf("close stats = %+v %v", closedStats, err)
	}
	closed, err := approvals.Get(ctx, scope, stale.ID)
	if err != nil || closed.Status != StatusCanceled || closed.CloseReason != ReasonRequirementUnresolvable {
		t.Fatalf("closed = %+v %v", closed, err)
	}
	assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionRunning)
	gateStep, gateJob := stepAndJob(t, ctx, store, scope, exec.ID, "gate")
	if gateStep.Status != wfstore.ExecutionFailed || gateJob.Status != wfstore.JobFailed {
		t.Fatalf("gate step=%s job=%s", gateStep.Status, gateJob.Status)
	}
	if code, _ := gateStep.Error["code"].(string); code != wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("gate error = %+v", gateStep.Error)
	}
	if port, _ := gateStep.Output["port"].(string); port == "expired" {
		t.Fatalf("gate took expired port: %+v", gateStep.Output)
	}
	sideStep, sideJob := stepAndJob(t, ctx, store, scope, exec.ID, "side")
	if sideStep.Status != wfstore.ExecutionRunning || sideJob.Status != wfstore.JobRunning {
		t.Fatalf("sibling step=%s job=%s", sideStep.Status, sideJob.Status)
	}
	lateStep, lateJob := stepAndJob(t, ctx, store, scope, exec.ID, "late")
	if lateStep.Status != wfstore.ExecutionPending || lateJob.Status != wfstore.JobBlocked || lateStep.StartedAt != nil {
		t.Fatalf("late step=%s job=%s", lateStep.Status, lateJob.Status)
	}
	var active int
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM executions
		 WHERE id = $1 AND status IN ('queued', 'running', 'waiting')
	`, exec.ID).Scan(&active); err != nil || active != 1 {
		t.Fatalf("slot released early: %d %v", active, err)
	}
	if _, err := store.CompleteJob(ctx, scope, now(), wfstore.JobActionInput{
		JobID: side.Job.ID, WorkerID: "edge-worker", FencingToken: side.Job.FencingToken,
		Output: map[string]any{"result": map[string]any{"ok": true}},
	}); err != nil {
		t.Fatal(err)
	}
	assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionFailed)
	if code, _ := stepAndJobMust(t, ctx, store, scope, exec.ID, "gate").Error["code"].(string); code != wfstore.ReasonRequirementUnresolvable {
		t.Fatal(code)
	}
	lateStep, lateJob = stepAndJob(t, ctx, store, scope, exec.ID, "late")
	if lateStep.Status != wfstore.ExecutionPending || lateJob.Status != wfstore.JobBlocked || lateStep.StartedAt != nil {
		t.Fatalf("late after sibling step=%s job=%s", lateStep.Status, lateJob.Status)
	}
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM executions
		 WHERE id = $1 AND status IN ('queued', 'running', 'waiting')
	`, exec.ID).Scan(&active); err != nil || active != 0 {
		t.Fatalf("slot still held: %d %v", active, err)
	}
}

func stepAndJobMust(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID, node string) wfstore.ExecutionStep {
	t.Helper()
	step, _ := stepAndJob(t, ctx, store, scope, executionID, node)
	return step
}

func parkGateHoldSibling(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, now time.Time, exec wfstore.Execution) wfstore.DispatchResult {
	t.Helper()
	var side wfstore.DispatchResult
	parked, held := false, false
	for i := 0; i < 4 && (!parked || !held); i++ {
		got, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		switch got.Step.NodeID {
		case "fork":
			if _, err := store.CompleteJob(ctx, scope, now, wfstore.JobActionInput{
				JobID: got.Job.ID, WorkerID: "edge-worker", FencingToken: got.Job.FencingToken,
				Output: map[string]any{"result": map[string]any{"ok": true}},
			}); err != nil {
				t.Fatal(err)
			}
		case "gate":
			if _, err := store.WaitJob(ctx, scope, now, wfstore.WaitJobInput{
				JobID: got.Job.ID, AvailableAt: now.Add(time.Hour), Approval: parkedSeed(exec),
			}); err != nil {
				t.Fatal(err)
			}
			parked = true
		case "side":
			running, err := store.HeartbeatJob(ctx, scope, now, wfstore.JobActionInput{
				JobID: got.Job.ID, WorkerID: "edge-worker", FencingToken: got.Job.FencingToken,
			})
			if err != nil {
				t.Fatal(err)
			}
			side = running
			held = true
		default:
			t.Fatalf("claimed %s", got.Step.NodeID)
		}
	}
	if !parked || !held {
		t.Fatal("gate and sibling were not both held")
	}
	return side
}

func siblingGateSrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: sibling-gate-` + formatSlug("sg", n) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: fork
      type: data.set
      name: Fork
      with:
        value:
          ok: true
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
        expiresIn: PT1H
    - id: side
      type: flow.stop
      name: Side
      with:
        status: success
    - id: late
      type: flow.stop
      name: Late
      with:
        status: success
  edges:
    - from: fork.result
      to: gate.request
    - from: fork.result
      to: side.input
    - from: gate.expired
      to: late.input
`
}

func expiredDownstreamSrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: expired-down-` + formatSlug("ed", n) + `
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
}

func TestPostgresResyncSkipsTransient(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	app, store, approvals, scope, exec, rec := parkFallback(t, ctx, "tr")
	defer app.Close()
	stats, err := resyncWorkspace(ctx, app, staticVersion{err: context.DeadlineExceeded}, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || stats.Closed != 0 || stats.Corrected != 0 {
		t.Fatalf("stats = %+v %v", stats, err)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusPending || got.CloseReason != "" || got.DecidedBy != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
	assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
	events, err := approvals.Events(ctx, scope, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.EventType == EventCanceled || ev.EventType == EventCorrected {
			t.Fatalf("event = %+v", ev)
		}
	}
}

func TestPostgresDecideTransientRecordsNothing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	app, _, approvals, scope, _, rec := parkFallback(t, ctx, "td")
	defer app.Close()
	approver, err := isolation.Authorize(scope.WorkspaceID(), "33333333-3333-4333-8333-333333333333")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := approvals.Decide(ctx, approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: time.Now().UTC(), Roles: []string{"admin"},
		Resolve: func(context.Context, isolation.Scope, Record) (policy.Requirement, error) {
			return policy.Requirement{}, fmt.Errorf("%w: dropped connection", ErrBindingTransient)
		},
	}); !errors.Is(err, ErrBindingTransient) {
		t.Fatalf("decide = %v", err)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusPending || got.DecidedBy != "" || got.ApproverRole != rec.ApproverRole || got.BindingFingerprint != rec.BindingFingerprint {
		t.Fatalf("row = %+v %v", got, err)
	}
	events, err := approvals.Events(ctx, scope, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.EventType == EventCorrected || ev.EventType == EventApproved || ev.EventType == EventCanceled {
			t.Fatalf("event = %+v", ev)
		}
	}
}

func TestPostgresResyncRebuildsFromRunPin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	app, store, approvals, scope, exec, rec := parkFallback(t, ctx, "rp")
	defer app.Close()
	stale := "sha256:" + strings.Repeat("f", 64)
	tx, err := postgres.BeginScoped(ctx, app, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE approvals SET workflow_digest = $2 WHERE id = $1::uuid`, rec.ID, stale); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	stats, err := resyncWorkspace(ctx, app, store, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || stats.Corrected != 1 || stats.Closed != 0 {
		t.Fatalf("stats = %+v %v", stats, err)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusPending || got.ApproverRole != "admin" || got.CloseReason != "" || got.DecidedBy != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
	assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
	step, job := stepAndJob(t, ctx, store, scope, exec.ID, "gate")
	if step.Status != wfstore.ExecutionWaiting || job.Status != wfstore.JobWaiting {
		t.Fatalf("gate step=%s job=%s", step.Status, job.Status)
	}
	if port, _ := step.Output["port"].(string); port == "expired" {
		t.Fatalf("gate output = %+v", step.Output)
	}
	if code, _ := step.Error["code"].(string); code == wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("gate error = %+v", step.Error)
	}
}

func TestPostgresResyncSkipsPrivilegeFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	app, store, approvals, scope, exec, rec := parkFallback(t, ctx, "pv")
	defer app.Close()
	denied := errors.Join(wfstore.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
	stats, err := resyncWorkspace(ctx, app, staticVersion{err: denied}, nil, scope.WorkspaceID(), time.Now().UTC())
	if err != nil || stats.Closed != 0 || stats.Corrected != 0 {
		t.Fatalf("stats = %+v %v", stats, err)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusPending || got.CloseReason != "" || got.ApproverRole != rec.ApproverRole {
		t.Fatalf("row = %+v %v", got, err)
	}
	assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
}

func TestPostgresResyncKeepsEachPolicyPin(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("pp", suffix), "PP")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("pu", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("pa", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	ops := opsconfig.NewPostgres(app)
	scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix)
	spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "approver", "expiresIn": "PT1H"}}
	policyA, _, err := ops.Create(ctx, scope, opsconfig.CreateInput{Kind: opsconfig.KindPolicy, Name: "Pin A", Slug: formatSlug("pa", suffix), Spec: spec})
	if err != nil {
		t.Fatal(err)
	}
	_, pubA, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, policyA.ID, opsconfig.PublishInput{ExpectedRevision: policyA.DraftRevision, Note: "a"})
	if err != nil {
		t.Fatal(err)
	}
	policyB, _, err := ops.Create(ctx, scope, opsconfig.CreateInput{Kind: opsconfig.KindPolicy, Name: "Pin B", Slug: formatSlug("pb", suffix), Spec: spec})
	if err != nil {
		t.Fatal(err)
	}
	_, pubB, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, policyB.ID, opsconfig.PublishInput{ExpectedRevision: policyB.DraftRevision, Note: "b"})
	if err != nil {
		t.Fatal(err)
	}
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: two-policies-` + formatSlug("pp", suffix) + `
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
    - id: gate-a
      type: flow.approval
      name: A
      with:
        approverRole: approver
        expiresIn: PT1H
        policyId: ` + policyA.ID + `
    - id: gate-b
      type: flow.approval
      name: B
      with:
        approverRole: approver
        expiresIn: PT1H
        policyId: ` + policyB.ID + `
    - id: gate-c
      type: flow.approval
      name: C
      with:
        approverRole: approver
        expiresIn: PT1H
  edges:
    - from: seed.result
      to: gate-a.request
    - from: seed.result
      to: gate-b.request
    - from: seed.result
      to: gate-c.request
`
	exec := publishRun(t, ctx, store, scope, src, "v1")
	if _, err := ops.BindPins(ctx, scope, opsconfig.BindInput{
		OwnerKind: opsconfig.OwnerExecution, OwnerID: exec.ID,
		Pins: []opsconfig.Pin{
			{Kind: opsconfig.KindPolicy, ResourceID: policyB.ID, VersionID: pubB.ID, VersionNumber: pubB.VersionNumber, Digest: pubB.Digest},
		},
	}); err != nil {
		t.Fatal(err)
	}
	// A second transaction gives policy A a later created_at. The old
	// loader took ORDER BY created_at LIMIT 1 and would attach B to every gate.
	pinTx, err := postgres.BeginScoped(ctx, admin, scope.WorkspaceID())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pinTx.Exec(ctx, `
		INSERT INTO ops_pins (
			workspace_id, owner_kind, owner_id, resource_kind, resource_id,
			version_id, version_number, digest
		) VALUES ($1::uuid, 'execution', $2::uuid, 'policy', $3::uuid, $4::uuid, $5, $6)
	`, scope.WorkspaceID(), exec.ID, policyA.ID, pubA.ID, pubA.VersionNumber, pubA.Digest); err != nil {
		pinTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := pinTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	completeSeed(t, ctx, store, scope, func() time.Time { return time.Now().UTC() })
	now := time.Now().UTC()
	parked := map[string]wfstore.DispatchResult{}
	for len(parked) < 3 {
		got, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		approval := &wfstore.ParkedApproval{
			WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
			ExecutionID: exec.ID, RequestedBy: exec.RequestedBy,
			NodeID: got.Step.NodeID, NodeName: got.Step.NodeID, Operation: "flow.approval", ApproverRole: "approver",
		}
		switch got.Step.NodeID {
		case "gate-a":
			approval.PolicyResourceID = policyA.ID
			approval.PolicyVersionID = pubA.ID
			approval.PolicyDigest = pubA.Digest
			approval.PolicyRevision = pubA.VersionNumber
		case "gate-b":
			approval.PolicyResourceID = policyB.ID
			approval.PolicyVersionID = pubB.ID
			approval.PolicyDigest = pubB.Digest
			approval.PolicyRevision = pubB.VersionNumber
		}
		if _, err := store.WaitJob(ctx, scope, now, wfstore.WaitJobInput{
			JobID: got.Job.ID, AvailableAt: now.Add(time.Hour), Approval: approval,
		}); err != nil {
			t.Fatal(err)
		}
		parked[got.Step.NodeID] = got
	}
	currentA := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	currentB := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	currentDigest := "sha256:" + strings.Repeat("9", 64)
	stats, err := resyncWorkspace(ctx, app, store, staticPins{pins: []opsconfig.Pin{
		{Kind: opsconfig.KindPolicy, ResourceID: policyB.ID, VersionID: currentB, VersionNumber: 9, Digest: currentDigest, Spec: map[string]any{"kind": "approval", "policy": map[string]any{}}},
		{Kind: opsconfig.KindPolicy, ResourceID: policyA.ID, VersionID: currentA, VersionNumber: 9, Digest: currentDigest, Spec: map[string]any{"kind": "approval", "policy": map[string]any{}}},
	}}, scope.WorkspaceID(), now)
	if err != nil || stats.Corrected != 0 || stats.Closed != 0 {
		t.Fatalf("stats = %+v %v", stats, err)
	}
	rows, err := approvals.List(ctx, scope, Filter{ExecutionID: exec.ID})
	if err != nil {
		t.Fatal(err)
	}
	byNode := map[string]Record{}
	for _, row := range rows {
		byNode[row.NodeID] = row
	}
	if len(byNode) != 3 {
		t.Fatalf("rows = %+v", rows)
	}
	if byNode["gate-a"].Status != StatusPending || byNode["gate-a"].PolicyResourceID != policyA.ID || byNode["gate-a"].PolicyVersionID != pubA.ID {
		t.Fatalf("gate-a = %+v", byNode["gate-a"])
	}
	if byNode["gate-b"].Status != StatusPending || byNode["gate-b"].PolicyResourceID != policyB.ID || byNode["gate-b"].PolicyVersionID != pubB.ID {
		t.Fatalf("gate-b = %+v", byNode["gate-b"])
	}
	if byNode["gate-c"].Status != StatusPending || byNode["gate-c"].PolicyResourceID != "" || byNode["gate-c"].PolicyVersionID != "" {
		t.Fatalf("gate-c = %+v", byNode["gate-c"])
	}
	for _, node := range []string{"gate-a", "gate-b", "gate-c"} {
		assertStepJob(t, ctx, store, scope, exec.ID, node, wfstore.ExecutionWaiting, wfstore.JobWaiting)
	}
}

func parkFallback(t *testing.T, ctx context.Context, tag string) (*pgxpool.Pool, *wfstore.Postgres, *Postgres, isolation.Scope, wfstore.Execution, Record) {
	t.Helper()
	dsn := testDatabaseURL(t)
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, formatSlug(tag, suffix), "T")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug(tag+"u", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug(tag+"a", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }
	scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix)
	exec := publishRun(t, ctx, store, scope, adminGateSrc(suffix), "v1")
	gate := claimStep(t, ctx, store, scope, now(), "gate")
	if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
		JobID: gate.Job.ID, AvailableAt: now().Add(time.Hour),
		Approval: &wfstore.ParkedApproval{
			WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
			ExecutionID: exec.ID, RequestedBy: exec.RequestedBy,
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval", ApproverRole: "approver",
		},
	}); err != nil {
		t.Fatal(err)
	}
	return app, store, approvals, scope, exec, onePending(t, ctx, approvals, scope, exec.ID)
}

func stopOnlySrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: stop-only-` + formatSlug("so", n) + `
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

func TestPostgresPolicyVersionPrivilegeStaysPending(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("vg", suffix), "VG")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("vu", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("va", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	ops := opsconfig.NewPostgres(app)
	scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix)
	spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "approver", "expiresIn": "PT1H"}}
	resource, draft, err := ops.Create(ctx, scope, opsconfig.CreateInput{
		Kind: opsconfig.KindPolicy, Name: "Version grant", Slug: formatSlug("vl", suffix), Spec: spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"}); err != nil {
		t.Fatal(err)
	}
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: version-grant-` + formatSlug("vg", suffix) + `
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
        policyId: ` + resource.ID + `
        expiresIn: PT1H
  edges: []
`
	exec := publishRun(t, ctx, store, scope, src, "v1")
	now := time.Now().UTC()
	rec, err := approvals.Create(ctx, scope, CreateInput{
		WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
		ExecutionID: exec.ID, RequestedBy: user.ID,
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `REVOKE SELECT ON ops_resource_versions FROM flowforge_app`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), `GRANT SELECT ON ops_resource_versions TO flowforge_app`)
	}()
	stats, err := resyncWorkspace(ctx, app, store, ops, scope.WorkspaceID(), now)
	if err != nil || stats.Closed != 0 || stats.Corrected != 0 {
		t.Fatalf("stats = %+v %v", stats, err)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusPending || got.CloseReason != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
	events, err := approvals.Events(ctx, scope, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.EventType == EventCanceled {
			t.Fatalf("canceled = %+v", ev)
		}
	}
}

func TestPostgresResyncKeepsStepRoleOnPinnedPolicy(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("pr", suffix), "PR")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("pu", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("pa", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	ops := opsconfig.NewPostgres(app)
	scope, _ := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix)
	v1Spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "admin", "expiresIn": "PT1H"}}
	resource, draft, err := ops.Create(ctx, scope, opsconfig.CreateInput{
		Kind: opsconfig.KindPolicy, Name: "Pinned role", Slug: formatSlug("pl", suffix), Spec: v1Spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver1, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: pinned-role-` + formatSlug("pr", suffix) + `
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
        policyId: ` + resource.ID + `
        expiresIn: PT1H
  edges: []
`
	exec := publishRun(t, ctx, store, scope, src, "v1")
	if _, err := ops.BindPins(ctx, scope, opsconfig.BindInput{
		OwnerKind: opsconfig.OwnerExecution, OwnerID: exec.ID,
		Pins: []opsconfig.Pin{{
			Kind: opsconfig.KindPolicy, ResourceID: resource.ID, VersionID: ver1.ID,
			VersionNumber: ver1.VersionNumber, Digest: ver1.Digest,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	if _, err := store.WaitJob(ctx, scope, now, wfstore.WaitJobInput{
		JobID: claimed.Job.ID, AvailableAt: now.Add(time.Hour),
		Approval: &wfstore.ParkedApproval{
			WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
			ExecutionID: exec.ID, RequestedBy: exec.RequestedBy,
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval", ApproverRole: "approver",
			PolicyResourceID: resource.ID, PolicyVersionID: ver1.ID, PolicyDigest: ver1.Digest, PolicyRevision: ver1.VersionNumber,
		},
	}); err != nil {
		t.Fatal(err)
	}
	v2Spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "auditor", "expiresIn": "PT2H"}}
	_, next, err := ops.SaveDraft(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.SaveInput{
		ExpectedRevision: draft.Revision, Name: "Pinned role", Spec: v2Spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver2, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.PublishInput{ExpectedRevision: next.Revision, Note: "v2"})
	if err != nil {
		t.Fatal(err)
	}
	stats, err := resyncWorkspace(ctx, app, store, ops, scope.WorkspaceID(), now)
	if err != nil || stats.Closed != 0 || stats.Corrected != 0 {
		t.Fatalf("stats = %+v %v", stats, err)
	}
	rows, err := approvals.List(ctx, scope, Filter{ExecutionID: exec.ID})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows = %+v %v", rows, err)
	}
	got := rows[0]
	if got.Status != StatusPending || got.ApproverRole != "approver" || got.PolicyVersionID != ver1.ID || got.PolicyVersionID == ver2.ID {
		t.Fatalf("row = %+v newer %s", got, ver2.ID)
	}
}
