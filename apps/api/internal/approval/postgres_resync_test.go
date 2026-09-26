package approval

import (
	"context"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
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
