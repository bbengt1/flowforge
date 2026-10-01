package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestRunnerApproveAfterGateExpiryIsClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dsn := postgresTestURL(t)
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
	tenant, err := ids.CreateTenant(ctx, formatRunnerSlug("rt", suffix), "RT")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("ru", suffix), "Runner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("ra", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatRunnerSlug("rw", suffix), "R", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	approver, err := isolation.Authorize(ws.ID, approverUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := approval.NewPostgres(app)

	t.Run("recovery closes the approval before decide", func(t *testing.T) {
		exec := startRunnerGate(t, ctx, store, scope, suffix)
		queue, loop := runnerLoop(store, ws.ID, user.ID)
		if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
			t.Fatalf("park n=%d err=%v", n, err)
		}
		rec, job := loadParkedApproval(t, ctx, store, approvals, scope, exec.ID)
		if rec.ExpiresAt.Sub(job.AvailableAt).Abs() > time.Millisecond {
			t.Fatalf("expires %s available %s", rec.ExpiresAt, job.AvailableAt)
		}
		queue.Now = func() time.Time { return time.Now().UTC().Add(2 * time.Hour) }
		if _, err := loop.PollOnce(ctx); err != nil {
			t.Fatal(err)
		}
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != approval.StatusExpired || got.DecidedBy != "" || got.CloseReason != "" {
			t.Fatalf("after recovery = %+v", got)
		}
		if _, err := approvals.Decide(ctx, approver, rec.ID, approval.DecideInput{
			Decision: approval.DecisionApproved, Now: time.Now().UTC(),
		}); !errors.Is(err, approval.ErrClosed) {
			t.Fatalf("decide = %v", err)
		}
		got, err = approvals.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != approval.StatusExpired || got.DecidedBy != "" {
			t.Fatalf("decided = %+v", got)
		}
		assertNoApprovedEvent(t, ctx, approvals, scope, rec.ID)
	})

	t.Run("decide in the gap expires the row and records nothing approved", func(t *testing.T) {
		exec := startRunnerGate(t, ctx, store, scope, suffix+1)
		_, loop := runnerLoop(store, ws.ID, user.ID)
		if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
			t.Fatalf("park n=%d err=%v", n, err)
		}
		rec, _ := loadParkedApproval(t, ctx, store, approvals, scope, exec.ID)
		if _, err := admin.Exec(ctx, `
			UPDATE execution_jobs SET status = 'succeeded', updated_at = now()
			 WHERE execution_id = $1::uuid AND status = 'waiting'
		`, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `
			UPDATE execution_steps
			   SET status = 'succeeded',
			       output_redacted = '{"port":"expired","decision":"expired"}'::jsonb,
			       finished_at = now(),
			       updated_at = now()
			 WHERE execution_id = $1::uuid AND node_type = 'flow.approval'
		`, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `
			UPDATE executions SET status = 'succeeded', finished_at = now(), updated_at = now()
			 WHERE id = $1::uuid
		`, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := approvals.Decide(ctx, approver, rec.ID, approval.DecideInput{
			Decision: approval.DecisionApproved, Now: time.Now().UTC(),
		}); !errors.Is(err, approval.ErrClosed) {
			t.Fatalf("decide = %v", err)
		}
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != approval.StatusExpired || got.DecidedBy != "" || got.CloseReason != "" {
			t.Fatalf("gap approval = %+v", got)
		}
		assertNoApprovedEvent(t, ctx, approvals, scope, rec.ID)
	})

	t.Run("delayed gate parks at claim time", func(t *testing.T) {
		parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: runner-delay-` + formatRunnerSlug("d", suffix+9) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Pause
      with:
        duration: PT2H
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1M
  edges:
    - from: pause.result
      to: gate.request
`))
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
		exec, err := store.StartExecution(ctx, scope, wf.ID, wfstore.StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		steps, err := store.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		var created time.Time
		for _, step := range steps {
			if step.NodeID == "gate" {
				created = step.CreatedAt
			}
		}
		t0 := time.Now().UTC()
		clock := t0
		queue := &StoreQueue{
			Workflows: store,
			JobKey:    wfstore.NewJobBindingKey(),
			WorkerID:  "production-runner",
			Lease:     time.Minute,
			Now:       func() time.Time { return clock },
			Fixed:     []Workspace{{ID: ws.ID, ActorID: user.ID}},
		}
		loop := NewRunner(queue, nil, Config{
			WorkerID: "production-runner",
			Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
		loop.now = func() time.Time { return clock }
		if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
			t.Fatalf("delay poll n=%d err=%v", n, err)
		}
		clock = t0.Add(2 * time.Hour)
		if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
			t.Fatalf("gate poll n=%d err=%v", n, err)
		}
		items, err := approvals.List(ctx, scope, approval.Filter{ExecutionID: exec.ID})
		if err != nil || len(items) != 1 {
			t.Fatalf("approvals = %+v %v", items, err)
		}
		want := clock.Add(time.Minute)
		if items[0].Status != approval.StatusPending || items[0].ExpiresAt.Sub(want).Abs() > time.Second {
			t.Fatalf("expires = %s want %s status %s", items[0].ExpiresAt, want, items[0].Status)
		}
		if !items[0].ExpiresAt.After(created.Add(time.Minute)) {
			t.Fatalf("parked from created_at %s expires %s", created, items[0].ExpiresAt)
		}
		if _, err := store.RecoverExpiredLeases(ctx, scope, clock); err != nil {
			t.Fatal(err)
		}
		got, err := approvals.Get(ctx, scope, items[0].ID)
		if err != nil || got.Status != approval.StatusPending {
			t.Fatalf("after claim-time recovery = %+v %v", got, err)
		}
		steps, err = store.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range steps {
			if step.NodeID == "gate" && step.Status != wfstore.ExecutionWaiting {
				t.Fatalf("gate = %+v", step)
			}
			if port, _ := step.Output["port"].(string); port == "expired" {
				t.Fatalf("%s took expired", step.NodeID)
			}
		}
	})
}

func startRunnerGate(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, suffix int64) wfstore.Execution {
	t.Helper()
	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: runner-gate-` + formatRunnerSlug("g", suffix) + `
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
  edges: []
`))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := store.Create(ctx, scope, wfstore.CreateInput{
		NormalizedYAML: parsed.NormalizedYAML,
		Digest:         parsed.Digest,
		Summary:        parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return exec
}

func runnerLoop(store *wfstore.Postgres, workspaceID, actorID string) (*StoreQueue, *Runner) {
	queue := &StoreQueue{
		Workflows: store,
		JobKey:    wfstore.NewJobBindingKey(),
		WorkerID:  "production-runner",
		Lease:     time.Minute,
		Fixed: []Workspace{{
			ID:      workspaceID,
			ActorID: actorID,
		}},
	}
	loop := NewRunner(queue, nil, Config{
		WorkerID: "production-runner",
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return queue, loop
}

func loadParkedApproval(t *testing.T, ctx context.Context, store *wfstore.Postgres, approvals *approval.Postgres, scope isolation.Scope, executionID string) (approval.Record, wfstore.ExecutionJob) {
	t.Helper()
	items, err := approvals.List(ctx, scope, approval.Filter{ExecutionID: executionID})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Status != approval.StatusPending {
		t.Fatalf("approvals = %+v", items)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Status != wfstore.JobWaiting {
		t.Fatalf("jobs = %+v", jobs)
	}
	return items[0], jobs[0]
}

func assertNoApprovedEvent(t *testing.T, ctx context.Context, approvals *approval.Postgres, scope isolation.Scope, approvalID string) {
	t.Helper()
	events, err := approvals.Events(ctx, scope, approvalID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.EventType == approval.EventApproved {
			t.Fatalf("approved event = %+v", ev)
		}
	}
}

func postgresTestURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	return dsn
}

func formatRunnerSlug(prefix string, n int64) string {
	return fmt.Sprintf("%s-%d", prefix, n%100000000)
}
