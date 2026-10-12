package approval

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Terry's repro: seed -> gate (approval) -> after, plus a parallel m
// whose lease expires. Recovery makes the run indeterminate while the gate
// is still waiting.
func runEndedSrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: run-ended-` + formatSlug("r", n) + `
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
    - id: m
      type: ssh.run
      name: M
      with:
        sshTargetId: 11111111-1111-4111-8111-111111111111
        commandProfileId: 22222222-2222-4222-8222-222222222222
  edges:
    - from: seed.result
      to: gate.request
    - from: gate.approved
      to: after.input
    - from: seed.result
      to: m.parameters
`
}

type runEndedHarness struct {
	t          *testing.T
	ctx        context.Context
	memory     bool
	wf         wfstore.Store
	ap         Store
	scope      isolation.Scope
	approver   isolation.Scope
	base       time.Time
	seq        int64
	workflowID string
	// fresh returns new stores and scopes for one case (Memory) or new
	// scopes in a new workspace (Postgres).
	fresh func(n int64) (wfstore.Store, Store, isolation.Scope, isolation.Scope)
}

type runEndedRun struct {
	exec wfstore.Execution
	gate wfstore.DispatchResult
	m    wfstore.DispatchResult
	rec  Record
}

func (h *runEndedHarness) start() runEndedRun {
	t := h.t
	t.Helper()
	h.seq++
	h.base = time.Now().UTC().Add(time.Second)
	h.wf, h.ap, h.scope, h.approver = h.fresh(h.seq)
	parsed, errs := workflow.ParseAndNormalize([]byte(runEndedSrc(time.Now().UnixNano() + h.seq)))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := h.wf.Create(h.ctx, h.scope, wfstore.CreateInput{NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := h.wf.Publish(h.ctx, h.scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := h.wf.StartExecution(h.ctx, h.scope, wf.ID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	h.workflowID = wf.ID
	run := runEndedRun{exec: exec}
	seed, err := h.wf.ClaimJob(h.ctx, h.scope, h.base, wfstore.ClaimInput{WorkerID: "re-worker", Lease: time.Minute})
	if err != nil || seed.Step.NodeID != "seed" {
		t.Fatalf("claim seed = %s %v", seed.Step.NodeID, err)
	}
	if _, err := h.wf.CompleteJob(h.ctx, h.scope, h.base, wfstore.JobActionInput{
		JobID: seed.Job.ID, WorkerID: "re-worker", FencingToken: seed.Job.FencingToken,
		Output: map[string]any{"result": map[string]any{"ticket": "CHG-1"}},
	}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		got, err := h.wf.ClaimJob(h.ctx, h.scope, h.base, wfstore.ClaimInput{WorkerID: "re-worker", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		switch got.Step.NodeID {
		case "gate":
			run.gate = got
		case "m":
			run.m = got
		default:
			t.Fatalf("claimed %s", got.Step.NodeID)
		}
	}
	var park *wfstore.ParkedApproval
	if !h.memory {
		park = parkedSeed(exec)
	}
	if _, err := h.wf.WaitJob(h.ctx, h.scope, h.base, wfstore.WaitJobInput{JobID: run.gate.Job.ID, AvailableAt: h.base.Add(time.Hour), Approval: park}); err != nil {
		t.Fatal(err)
	}
	if h.memory {
		if _, err := h.ap.Create(h.ctx, h.scope, CreateInput{
			WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
			ExecutionID: exec.ID,
			Requirement: policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: h.base.Add(time.Hour)},
		}); err != nil {
			t.Fatal(err)
		}
	}
	items, err := h.ap.List(h.ctx, h.scope, Filter{Status: StatusPending, ExecutionID: exec.ID})
	if err != nil || len(items) != 1 {
		t.Fatalf("pending = %d %v", len(items), err)
	}
	run.rec = items[0]
	return run
}

func (h *runEndedHarness) recover() error {
	_, err := h.wf.RecoverExpiredLeases(h.ctx, h.scope, h.base.Add(2*time.Minute))
	return err
}

func (h *runEndedHarness) decide(rec Record) error {
	_, err := h.ap.Decide(h.ctx, h.approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: h.base.Add(3 * time.Minute), Roles: []string{"approver"},
		Resolve: func(context.Context, isolation.Scope, Record) (policy.Requirement, error) {
			return StoredRequirement(rec), nil
		},
	})
	return err
}

func (h *runEndedHarness) step(executionID, node string) (wfstore.ExecutionStep, wfstore.ExecutionJob) {
	t := h.t
	t.Helper()
	steps, err := h.wf.ListSteps(h.ctx, h.scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := h.wf.ListJobs(h.ctx, h.scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var step wfstore.ExecutionStep
	for _, s := range steps {
		if s.NodeID == node && s.Attempt >= step.Attempt {
			step = s
		}
	}
	for _, j := range jobs {
		if j.ExecutionStepID == step.ID {
			return step, j
		}
	}
	t.Fatalf("no job for %s", node)
	return step, wfstore.ExecutionJob{}
}

func (h *runEndedHarness) status(executionID string) string {
	h.t.Helper()
	exec, err := h.wf.GetExecution(h.ctx, h.scope, h.workflowID, executionID)
	if err != nil {
		h.t.Fatal(err)
	}
	return exec.Status
}

func (h *runEndedHarness) approval(id string) Record {
	h.t.Helper()
	got, err := h.ap.Get(h.ctx, h.scope, id)
	if err != nil {
		h.t.Fatal(err)
	}
	return got
}

func (h *runEndedHarness) noPending(executionID string) {
	h.t.Helper()
	items, err := h.ap.List(h.ctx, h.scope, Filter{Status: StatusPending, ExecutionID: executionID})
	if err != nil || len(items) != 0 {
		h.t.Fatalf("pending after run end = %+v %v", items, err)
	}
}

func (h *runEndedHarness) assertRunEnded(run runEndedRun) {
	t := h.t
	t.Helper()
	gate, gateJob := h.step(run.exec.ID, "gate")
	if gate.Status != wfstore.ExecutionFailed || gate.Error["code"] != wfstore.ReasonRunEnded || gateJob.Status != wfstore.JobFailed {
		t.Fatalf("gate = %s %+v job %s", gate.Status, gate.Error, gateJob.Status)
	}
	h.noPending(run.exec.ID)
	got := h.approval(run.rec.ID)
	if got.Status != StatusCanceled || got.CloseReason != ReasonRunEnded || got.DecidedBy != "" {
		t.Fatalf("approval = %s %q %q", got.Status, got.CloseReason, got.DecidedBy)
	}
}

func runRunEndedSuite(t *testing.T, h *runEndedHarness) {
	t.Run("lease loss ends the run and closes the gate with run_ended", func(t *testing.T) {
		h.t = t
		run := h.start()
		if err := h.recover(); err != nil {
			t.Fatal(err)
		}
		if got := h.status(run.exec.ID); got != wfstore.ExecutionIndeterminate {
			t.Fatalf("run = %s", got)
		}
		h.assertRunEnded(run)
		if after, _ := h.step(run.exec.ID, "after"); after.Status != wfstore.ExecutionSkipped {
			t.Fatalf("after = %s %q", after.Status, after.SkipReason)
		}
		if err := h.decide(run.rec); !errors.Is(err, ErrRunFinished) {
			t.Fatalf("approve after end = %v, want ErrRunFinished", err)
		}
		if got := h.approval(run.rec.ID); got.Status != StatusCanceled || got.DecidedBy != "" {
			t.Fatalf("approval after refused decide = %+v", got)
		}
	})

	t.Run("cancel closes the approval with run_canceled", func(t *testing.T) {
		h.t = t
		run := h.start()
		if _, err := h.wf.CancelExecution(h.ctx, h.scope, h.base, run.exec.ID); err != nil {
			t.Fatal(err)
		}
		if h.memory { // the HTTP handler closes Memory approvals after cancel
			if err := h.ap.ClosePendingForExecution(h.ctx, h.scope, run.exec.ID, ReasonRunCanceled, h.base); err != nil {
				t.Fatal(err)
			}
		}
		h.noPending(run.exec.ID)
		if got := h.approval(run.rec.ID); got.Status != StatusCanceled || got.CloseReason != ReasonRunCanceled {
			t.Fatalf("approval = %s %q", got.Status, got.CloseReason)
		}
		if gate, _ := h.step(run.exec.ID, "gate"); gate.Status == wfstore.ExecutionWaiting {
			t.Fatalf("gate still waiting")
		}
		if err := h.decide(run.rec); !errors.Is(err, ErrClosed) {
			t.Fatalf("decide = %v", err)
		}
	})

	t.Run("workflow delete closes the approval with workflow_deleted", func(t *testing.T) {
		h.t = t
		run := h.start()
		// m holds a live lease, so delete is refused until recovery ends it;
		// fail m instead so only the parked gate is left.
		if _, err := h.wf.FailJob(h.ctx, h.scope, h.base, wfstore.JobActionInput{
			JobID: run.m.Job.ID, WorkerID: "re-worker", FencingToken: run.m.Job.FencingToken,
			Error: map[string]any{"code": "boom", "message": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		res, err := h.wf.Delete(h.ctx, h.scope, run.exec.WorkflowID)
		if err != nil {
			t.Fatal(err)
		}
		if h.memory {
			for _, id := range res.ClosedRuns {
				if err := h.ap.ClosePendingForExecution(h.ctx, h.scope, id, ReasonWorkflowDeleted, h.base); err != nil {
					t.Fatal(err)
				}
			}
		}
		h.noPending(run.exec.ID)
		if got := h.approval(run.rec.ID); got.Status != StatusCanceled || got.CloseReason != ReasonWorkflowDeleted {
			t.Fatalf("approval = %s %q", got.Status, got.CloseReason)
		}
		if gate, _ := h.step(run.exec.ID, "gate"); gate.Status == wfstore.ExecutionWaiting {
			t.Fatalf("gate still waiting")
		}
	})

	t.Run("plain failure beside a waiting gate", func(t *testing.T) {
		h.t = t
		run := h.start()
		if _, err := h.wf.FailJob(h.ctx, h.scope, h.base, wfstore.JobActionInput{
			JobID: run.m.Job.ID, WorkerID: "re-worker", FencingToken: run.m.Job.FencingToken,
			Error: map[string]any{"code": "boom", "message": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		status := h.status(run.exec.ID)
		t.Logf("run after plain failure = %s", status)
		if status == wfstore.ExecutionFailed {
			h.assertRunEnded(run)
			if err := h.decide(run.rec); !errors.Is(err, ErrRunFinished) {
				t.Fatalf("decide = %v", err)
			}
			return
		}
		// The rollup keeps a run with a parked gate waiting until the
		// gate is decided; nothing has ended, so nothing closes.
		if status != wfstore.ExecutionWaiting {
			t.Fatalf("run = %s", status)
		}
		if got := h.approval(run.rec.ID); got.Status != StatusPending {
			t.Fatalf("approval = %s", got.Status)
		}
	})

	t.Run("approve races the run-ending close-out", func(t *testing.T) {
		h.t = t
		wins := map[string]int{}
		for i := 0; i < 24; i++ {
			run := h.start()
			var decideErr, recoverErr error
			var wg sync.WaitGroup
			wg.Add(2)
			go func() { defer wg.Done(); decideErr = h.decide(run.rec) }()
			go func() { defer wg.Done(); recoverErr = h.recover() }()
			wg.Wait()
			if recoverErr != nil {
				t.Fatalf("recover = %v", recoverErr)
			}
			if got := h.status(run.exec.ID); got != wfstore.ExecutionIndeterminate {
				t.Fatalf("run = %s", got)
			}
			got := h.approval(run.rec.ID)
			switch {
			case decideErr == nil:
				wins["approve"]++
				if got.Status != StatusApproved || got.CloseReason != "" || got.DecidedBy == "" {
					t.Fatalf("approve won but approval = %s %q", got.Status, got.CloseReason)
				}
			case errors.Is(decideErr, ErrRunFinished):
				wins["close-out"]++
				if got.Status != StatusCanceled || got.CloseReason != ReasonRunEnded || got.DecidedBy != "" {
					t.Fatalf("close-out won but approval = %s %q", got.Status, got.CloseReason)
				}
			default:
				t.Fatalf("decide = %v", decideErr)
			}
			if gate, _ := h.step(run.exec.ID, "gate"); gate.Status == wfstore.ExecutionWaiting {
				t.Fatalf("gate still waiting after run ended")
			}
		}
		t.Logf("wins = %v", wins)
	})
}

func TestMemoryRunEndedClosesApprovals668(t *testing.T) {
	h := &runEndedHarness{ctx: context.Background(), memory: true, base: time.Now().UTC().Add(time.Second)}
	h.fresh = func(n int64) (wfstore.Store, Store, isolation.Scope, isolation.Scope) {
		wf := wfstore.NewMemory()
		ap := NewMemory()
		ap.SetGateWaiting(wf.ApprovalGateWaiting)
		ap.SetRunEnded(wf.RunEndedForApprovals)
		wf.SetApprovalPending(ap.PendingExpiry)
		owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
		if err != nil {
			t.Fatal(err)
		}
		approver, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "55555555-5555-4555-8555-555555555555")
		if err != nil {
			t.Fatal(err)
		}
		return wf, ap, owner, approver
	}
	runRunEndedSuite(t, h)
}

func TestPostgresRunEndedClosesApprovals668(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("re", suffix), "RE")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("reu", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("rea", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	wf := wfstore.NewPostgres(app)
	ap := NewPostgres(app)
	h := &runEndedHarness{ctx: ctx, base: time.Now().UTC().Add(time.Second)}
	h.fresh = func(n int64) (wfstore.Store, Store, isolation.Scope, isolation.Scope) {
		scope, approver := desk(t, ctx, ids, tenant.ID, user.ID, approverUser.ID, suffix+n)
		return wf, ap, scope, approver
	}
	runRunEndedSuite(t, h)
}
