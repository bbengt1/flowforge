package runner

import (
	"context"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/workflowhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// The production runner park path applies the same targeting rule as the
// compose claim path: no eligible decider fails the gate with
// no_eligible_decider; a second admin lets it park with the snapshot.
func TestRunnerTargetedGatePark(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatRunnerSlug("tt", suffix), "TT")
	if err != nil {
		t.Fatal(err)
	}
	owner, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("tu", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	other, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("ta", suffix), "Second admin")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatRunnerSlug("tw", suffix), "T", owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	group, err := ids.CreateGroup(ctx, ws.ID, identity.GroupActor{UserID: owner.ID}, "Runner approvers")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := approval.NewPostgres(app)

	t.Run("no eligible decider fails the gate", func(t *testing.T) {
		exec := startTargetedGate(t, ctx, store, scope, suffix, group.ID)
		_, loop := runnerLoop(store, ws.ID, owner.ID)
		if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
			t.Fatalf("drain n=%d err=%v", n, err)
		}
		steps, err := store.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		details, _ := steps[0].Error["details"].(map[string]any)
		if len(steps) != 1 || steps[0].Status != wfstore.ExecutionFailed || steps[0].Error["code"] != wfstore.ReasonRequirementUnresolvable || details["cause"] != approval.CauseNoEligibleDecider {
			t.Fatalf("step = %+v", steps)
		}
		got, err := store.GetExecutionByID(ctx, scope, exec.ID)
		if err != nil || got.Status != wfstore.ExecutionFailed {
			t.Fatalf("run = %+v %v", got, err)
		}
		if d := workflowhttp.ExecutionStatusReasonDetails(got, steps); d["cause"] != approval.CauseNoEligibleDecider {
			t.Fatalf("statusReasonDetails = %+v", d)
		}
		rows, err := approvals.List(ctx, scope, approval.Filter{ExecutionID: exec.ID})
		if err != nil || len(rows) != 0 {
			t.Fatalf("approvals = %+v %v", rows, err)
		}
	})

	t.Run("second admin parks with the snapshot", func(t *testing.T) {
		if err := ids.SetMemberRoles(ctx, ws.ID, other.ID, []string{"admin"}); err != nil {
			t.Fatal(err)
		}
		exec := startTargetedGate(t, ctx, store, scope, suffix+1, group.ID)
		_, loop := runnerLoop(store, ws.ID, owner.ID)
		if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
			t.Fatalf("drain n=%d err=%v", n, err)
		}
		rows, err := approvals.List(ctx, scope, approval.Filter{ExecutionID: exec.ID})
		if err != nil || len(rows) != 1 || rows[0].Status != approval.StatusPending {
			t.Fatalf("approvals = %+v %v", rows, err)
		}
		row := rows[0]
		if !row.Targeted() || len(row.ApproverGroupIDs) != 1 || row.ApproverGroupIDs[0] != group.ID || len(row.ApproverUserIDs) != 0 {
			t.Fatalf("snapshot = digest %q users %v groups %v", row.ApproversDigest, row.ApproverUserIDs, row.ApproverGroupIDs)
		}
		otherScope, err := isolation.Authorize(ws.ID, other.ID)
		if err != nil {
			t.Fatal(err)
		}
		targets, err := approvals.TargetsCaller(ctx, otherScope, rows, other.ID)
		if err != nil || targets[row.ID] {
			t.Fatalf("second admin is not targeted: %v %v", targets, err)
		}
	})
}

func startTargetedGate(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, suffix int64, groupID string) wfstore.Execution {
	t.Helper()
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: targeted-gate-` + formatRunnerSlug("g", suffix) + `
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
        approvers:
          groups: ["` + groupID + `"]
  edges: []
`
	parsed, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := store.Create(ctx, scope, wfstore.CreateInput{NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary})
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
