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
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPostgresCloseApprovalsOnCancelAndDelete(t *testing.T) {
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

	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, formatSlug("apc", suffix), "APC")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("acu", suffix), "APC User")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("acw", suffix), "A", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	workflows := wfstore.NewPostgres(app)
	store := NewPostgres(app)
	now := time.Now().UTC().Add(time.Second)

	t.Run("cancel closes and decide is closed", func(t *testing.T) {
		exec := startApprovalRun(t, ctx, workflows, scope)
		rec := bindApproval(t, ctx, store, scope, exec)
		if _, err := workflows.CancelExecution(ctx, scope, now, exec.ID); err != nil {
			t.Fatal(err)
		}
		got, err := store.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusCanceled || got.CloseReason != ReasonRunCanceled || got.DecidedBy != "" {
			t.Fatalf("approval = %+v", got)
		}
		pending, err := store.List(ctx, scope, Filter{Status: StatusPending, ExecutionID: exec.ID})
		if err != nil || len(pending) != 0 {
			t.Fatalf("pending = %+v %v", pending, err)
		}
		if _, err := store.Decide(ctx, scope, rec.ID, DecideInput{Decision: DecisionApproved, Now: now}); !errors.Is(err, ErrClosed) {
			t.Fatalf("decide = %v", err)
		}
	})

	t.Run("workflow deleted closes and decide is closed", func(t *testing.T) {
		exec := startApprovalRun(t, ctx, workflows, scope)
		rec := bindApproval(t, ctx, store, scope, exec)
		claimed, err := workflows.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "approval-worker", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := workflows.WaitJob(ctx, scope, now, wfstore.WaitJobInput{JobID: claimed.Job.ID, AvailableAt: now.Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := workflows.Delete(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatal(err)
		}
		if err := workflows.AbandonIfWorkflowDeleted(ctx, scope, now, exec.ID); !errors.Is(err, wfstore.ErrWorkflowDeleted) {
			t.Fatalf("abandon = %v", err)
		}
		got, err := store.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusCanceled || got.CloseReason != ReasonWorkflowDeleted || got.DecidedBy != "" {
			t.Fatalf("approval = %+v", got)
		}
		if _, err := store.Decide(ctx, scope, rec.ID, DecideInput{Decision: DecisionApproved, Now: now}); !errors.Is(err, ErrClosed) {
			t.Fatalf("decide = %v", err)
		}
	})

	t.Run("backfill closes approvals left pending", func(t *testing.T) {
		exec := startApprovalRun(t, ctx, workflows, scope)
		rec := bindApproval(t, ctx, store, scope, exec)
		if _, err := admin.Exec(ctx, `UPDATE executions SET status = 'canceled' WHERE id = $1::uuid`, exec.ID); err != nil {
			t.Fatal(err)
		}
		deleted := startApprovalRun(t, ctx, workflows, scope)
		deletedRec := bindApproval(t, ctx, store, scope, deleted)
		if _, err := admin.Exec(ctx, `UPDATE executions SET status = 'failed' WHERE id = $1::uuid`, deleted.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `
			UPDATE execution_steps
			   SET error_redacted = '{"code":"workflow_deleted","message":"Workflow was deleted."}'::jsonb
			 WHERE execution_id = $1::uuid
		`, deleted.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `SELECT app.backfill_close_stale_approvals()`); err != nil {
			t.Fatal(err)
		}
		got, err := store.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusCanceled || got.CloseReason != ReasonRunCanceled || got.DecidedBy != "" {
			t.Fatalf("canceled = %+v", got)
		}
		got, err = store.Get(ctx, scope, deletedRec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusCanceled || got.CloseReason != ReasonWorkflowDeleted || got.DecidedBy != "" {
			t.Fatalf("deleted = %+v", got)
		}
		events, err := store.Events(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		saw := false
		for _, ev := range events {
			if ev.EventType != EventCanceled {
				continue
			}
			saw = true
			if ev.ActorID != "" || ev.Details["reason"] != ReasonRunCanceled || len(ev.Details) != 1 {
				t.Fatalf("event = %+v", ev)
			}
		}
		if !saw {
			t.Fatal("missing canceled event")
		}
	})

	t.Run("cancel races decide", func(t *testing.T) {
		approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("apd", suffix), "Approver")
		if err != nil {
			t.Fatal(err)
		}
		approver, err := isolation.Authorize(ws.ID, approverUser.ID)
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 4; i++ {
			exec := startApprovalRun(t, ctx, workflows, scope)
			rec := bindApproval(t, ctx, store, scope, exec)
			var decideErr, cancelErr error
			var decided Record
			assertNoDeadlock(t, func() error {
				decided, decideErr = store.Decide(ctx, approver, rec.ID, DecideInput{
					Decision: DecisionApproved, Now: now, Roles: []string{"approver"},
					Resolve: func(context.Context, isolation.Scope, Record) (policy.Requirement, error) {
						return StoredRequirement(rec), nil
					},
				})
				return decideErr
			}, func() error {
				_, cancelErr = workflows.CancelExecution(ctx, scope, now, exec.ID)
				return cancelErr
			})
			if cancelErr != nil {
				t.Fatalf("cancel = %v", cancelErr)
			}
			got, err := store.Get(ctx, scope, rec.ID)
			if err != nil {
				t.Fatal(err)
			}
			run, err := workflows.GetExecutionByID(ctx, scope, exec.ID)
			if err != nil {
				t.Fatal(err)
			}
			if run.Status != wfstore.ExecutionCanceled {
				t.Fatalf("run = %s", run.Status)
			}
			switch {
			case decideErr == nil:
				if decided.Status != DecisionApproved || got.Status != DecisionApproved || got.CloseReason != "" {
					t.Fatalf("decision won but approval = %+v decided %+v", got, decided)
				}
			case errors.Is(decideErr, ErrClosed):
				if got.Status != StatusCanceled || got.CloseReason != ReasonRunCanceled || got.DecidedBy != "" {
					t.Fatalf("cancel won but approval = %+v", got)
				}
			default:
				t.Fatalf("decide = %v", decideErr)
			}
		}
	})
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

func startApprovalRun(t *testing.T, ctx context.Context, workflows *wfstore.Postgres, scope isolation.Scope) wfstore.Execution {
	t.Helper()
	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: approval-close-` + time.Now().UTC().Format("150405.000000000") + `
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
	wf, draft, err := workflows.Create(ctx, scope, wfstore.CreateInput{
		NormalizedYAML: parsed.NormalizedYAML,
		Digest:         parsed.Digest,
		Summary:        parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := workflows.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := workflows.StartExecution(ctx, scope, wf.ID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return exec
}

func bindApproval(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, exec wfstore.Execution) Record {
	t.Helper()
	rec, err := store.Create(ctx, scope, CreateInput{
		WorkflowID:        exec.WorkflowID,
		WorkflowVersionID: exec.WorkflowVersionID,
		WorkflowDigest:    exec.WorkflowDigest,
		ExecutionID:       exec.ID,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return rec
}
