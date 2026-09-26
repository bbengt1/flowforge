package runner

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestRunnerApprovalBindingFailsClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
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
	tenant, err := ids.CreateTenant(ctx, formatRunnerSlug("bt", suffix), "BT")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("bu", suffix), "Runner")
	if err != nil {
		t.Fatal(err)
	}
	approverUser, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("ba", suffix), "Approver")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatRunnerSlug("bw", suffix), "B", user.ID)
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

	t.Run("version lookup failure", func(t *testing.T) {
		exec := startAdminGate(t, ctx, store, scope, suffix)
		queue, loop := runnerLoop(store, ws.ID, user.ID)
		queue.Workflows = versionLookup{Store: store, get: func(context.Context, isolation.Scope, string, string) (wfstore.Version, error) {
			return wfstore.Version{}, wfstore.ErrNotFound
		}}
		assertBindingFailed(t, ctx, loop, store, approvals, scope, approver, exec.ID)
	})

	t.Run("evaluate failure", func(t *testing.T) {
		exec := startAdminGate(t, ctx, store, scope, suffix+1)
		queue, loop := runnerLoop(store, ws.ID, user.ID)
		queue.Workflows = versionLookup{Store: store, get: func(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (wfstore.Version, error) {
			ver, err := store.GetVersion(ctx, scope, workflowID, versionID)
			if err != nil {
				return ver, err
			}
			ver.DefinitionYAML = "kind: nope\n"
			return ver, nil
		}}
		assertBindingFailed(t, ctx, loop, store, approvals, scope, approver, exec.ID)
	})

	t.Run("missing requirement", func(t *testing.T) {
		exec := startAdminGate(t, ctx, store, scope, suffix+2)
		queue, loop := runnerLoop(store, ws.ID, user.ID)
		queue.Workflows = versionLookup{Store: store, get: func(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (wfstore.Version, error) {
			ver, err := store.GetVersion(ctx, scope, workflowID, versionID)
			if err != nil {
				return ver, err
			}
			parsed, errs := workflow.ParseAndNormalize([]byte(otherGateYAML(suffix + 2)))
			if len(errs) > 0 {
				t.Fatalf("parse: %+v", errs)
			}
			ver.DefinitionYAML = parsed.NormalizedYAML
			return ver, nil
		}}
		assertBindingFailed(t, ctx, loop, store, approvals, scope, approver, exec.ID)
	})

	t.Run("sync drops a pending row for the wrong role", func(t *testing.T) {
		exec := startAdminGate(t, ctx, store, scope, suffix+3)
		wrong, err := approvals.Create(ctx, scope, approval.CreateInput{
			WorkflowID:        exec.WorkflowID,
			WorkflowVersionID: exec.WorkflowVersionID,
			WorkflowDigest:    exec.WorkflowDigest,
			ExecutionID:       exec.ID,
			Requirement: policy.Requirement{
				NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
				ApproverRole: "approver", ExpiresAt: time.Now().UTC().Add(time.Hour),
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		right, err := approvals.Create(ctx, scope, approval.CreateInput{
			WorkflowID:        exec.WorkflowID,
			WorkflowVersionID: exec.WorkflowVersionID,
			WorkflowDigest:    exec.WorkflowDigest,
			ExecutionID:       exec.ID,
			Requirement: policy.Requirement{
				NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
				ApproverRole: "admin", ExpiresAt: time.Now().UTC().Add(time.Hour),
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if right.ID == wrong.ID || right.ApproverRole != "admin" || right.BindingFingerprint == wrong.BindingFingerprint {
			t.Fatalf("replacement = %+v old %+v", right, wrong)
		}
		got, err := approvals.Get(ctx, scope, wrong.ID)
		if err != nil || got.Status != approval.StatusInvalidated {
			t.Fatalf("old = %+v %v", got, err)
		}
		if _, err := approvals.Decide(ctx, approver, wrong.ID, approval.DecideInput{
			Decision: approval.DecisionApproved, Now: time.Now().UTC(),
		}); err == nil {
			t.Fatal("approver decided a replaced row")
		}
		if approval.HasApproverRole([]string{"approver"}, right.ApproverRole) {
			t.Fatal("approver must not satisfy admin")
		}
	})
}

type versionLookup struct {
	wfstore.Store
	get func(context.Context, isolation.Scope, string, string) (wfstore.Version, error)
}

func (v versionLookup) GetVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (wfstore.Version, error) {
	if v.get != nil {
		return v.get(ctx, scope, workflowID, versionID)
	}
	return v.Store.GetVersion(ctx, scope, workflowID, versionID)
}

func assertBindingFailed(t *testing.T, ctx context.Context, loop *Runner, store *wfstore.Postgres, approvals *approval.Postgres, scope, approver isolation.Scope, executionID string) {
	t.Helper()
	if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
		t.Fatalf("drain n=%d err=%v", n, err)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Status != wfstore.JobFailed {
		t.Fatalf("jobs = %+v", jobs)
	}
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 1 || steps[0].Status == wfstore.ExecutionWaiting || steps[0].Error["code"] != CodeApprovalBindingUnresolved {
		t.Fatalf("step = %+v", steps)
	}
	items, err := approvals.List(ctx, scope, approval.Filter{ExecutionID: executionID})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("approvals = %+v", items)
	}
	if _, err := approvals.Decide(ctx, approver, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", approval.DecideInput{
		Decision: approval.DecisionApproved, Now: time.Now().UTC(),
	}); !errors.Is(err, approval.ErrNotFound) {
		t.Fatalf("approver decide = %v", err)
	}
}

func startAdminGate(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, suffix int64) wfstore.Execution {
	t.Helper()
	parsed, errs := workflow.ParseAndNormalize([]byte(adminGateYAML(suffix)))
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

func adminGateYAML(suffix int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: admin-gate-` + formatRunnerSlug("g", suffix) + `
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
  edges: []
`
}

func otherGateYAML(suffix int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: other-gate-` + formatRunnerSlug("o", suffix) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: other
      type: flow.approval
      name: Other
      with:
        approverRole: admin
        expiresIn: PT1H
  edges: []
`
}
