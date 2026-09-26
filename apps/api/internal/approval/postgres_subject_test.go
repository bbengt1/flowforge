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
)

func TestPostgresSubjectMembershipIsNotUnresolvable(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("sm", suffix), "SM")
	if err != nil {
		t.Fatal(err)
	}
	owner, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("so", suffix), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	target, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("st", suffix), "Target")
	if err != nil {
		t.Fatal(err)
	}
	member, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("sn", suffix), "Member")
	if err != nil {
		t.Fatal(err)
	}
	other, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("sx", suffix), "Other")
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := NewPostgres(app)
	subjects := NewSubjectDirectory(app)
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }

	t.Run("removed user stays pending", func(t *testing.T) {
		scope, targetScope := desk(t, ctx, ids, tenant.ID, owner.ID, target.ID, suffix)
		if err := ids.SetMemberRoles(ctx, scope.WorkspaceID(), target.ID, []string{"approver"}); err != nil {
			t.Fatal(err)
		}
		if err := ids.SetMemberRoles(ctx, scope.WorkspaceID(), other.ID, []string{"approver"}); err != nil {
			t.Fatal(err)
		}
		otherScope, err := isolation.Authorize(scope.WorkspaceID(), other.ID)
		if err != nil {
			t.Fatal(err)
		}
		exec := publishRun(t, ctx, store, scope, userGateSrc(suffix, target.ID), "v1")
		parkGate(t, ctx, store, scope, now(), exec)
		if err := ids.RemoveMember(ctx, scope.WorkspaceID(), target.ID); err != nil {
			t.Fatal(err)
		}
		rec := onePending(t, ctx, approvals, scope, exec.ID)
		stats, err := resyncWorkspace(ctx, app, store, nil, subjects, scope.WorkspaceID(), now())
		if err != nil || stats.Closed != 0 || stats.Corrected != 1 {
			t.Fatalf("stats = %+v %v", stats, err)
		}
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil || got.Status != StatusPending || got.ApproverUserID != target.ID || got.CloseReason != "" {
			t.Fatalf("rebuilt = %+v %v", got, err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
		if _, err := approvals.Decide(ctx, targetScope, rec.ID, subjectDecide(now(), subjects, store)); !errors.Is(err, ErrForbidden) {
			t.Fatalf("removed user decide = %v", err)
		}
		if _, err := approvals.Decide(ctx, otherScope, rec.ID, subjectDecide(now(), subjects, store)); !errors.Is(err, ErrForbidden) {
			t.Fatalf("other member decide = %v", err)
		}
		still, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil || still.Status != StatusPending || still.DecidedBy != "" {
			t.Fatalf("after deny = %+v %v", still, err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
		if err := ids.SetMemberRoles(ctx, scope.WorkspaceID(), target.ID, []string{"approver"}); err != nil {
			t.Fatal(err)
		}
		approved, err := approvals.Decide(ctx, targetScope, rec.ID, subjectDecide(now(), subjects, store))
		if err != nil || approved.Status != StatusApproved || approved.DecidedBy != target.ID {
			t.Fatalf("re-added decide = %+v %v", approved, err)
		}
	})

	t.Run("empty group stays pending", func(t *testing.T) {
		scope, memberScope := desk(t, ctx, ids, tenant.ID, owner.ID, member.ID, suffix+1)
		if err := ids.SetMemberRoles(ctx, scope.WorkspaceID(), member.ID, []string{"approver"}); err != nil {
			t.Fatal(err)
		}
		groupID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01"
		insertApproverGroup(t, ctx, admin, scope.WorkspaceID(), groupID)
		exec := publishRun(t, ctx, store, scope, groupGateSrc(suffix+1, groupID), "v1")
		parkGate(t, ctx, store, scope, now(), exec)
		rec := onePending(t, ctx, approvals, scope, exec.ID)
		stats, err := resyncWorkspace(ctx, app, store, nil, subjects, scope.WorkspaceID(), now())
		if err != nil || stats.Closed != 0 || stats.Corrected != 1 {
			t.Fatalf("stats = %+v %v", stats, err)
		}
		got, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil || got.Status != StatusPending || got.ApproverGroupID != groupID {
			t.Fatalf("rebuilt = %+v %v", got, err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
		denied := subjectDecide(now(), subjects, store)
		denied.GroupIDs = []string{groupID}
		if _, err := approvals.Decide(ctx, memberScope, rec.ID, denied); !errors.Is(err, ErrForbidden) {
			t.Fatalf("empty group decide = %v", err)
		}
		still, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil || still.Status != StatusPending || still.ApproverGroupID != groupID || still.DecidedBy != "" {
			t.Fatalf("after deny = %+v %v", still, err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
		insertApproverGroupMember(t, ctx, admin, scope.WorkspaceID(), groupID, member.ID)
		approved, err := approvals.Decide(ctx, memberScope, rec.ID, subjectDecide(now(), subjects, store))
		if err != nil || approved.Status != StatusApproved || approved.DecidedBy != member.ID {
			t.Fatalf("repopulated decide = %+v %v", approved, err)
		}
	})

	t.Run("deleted group is unresolvable", func(t *testing.T) {
		scope, _ := desk(t, ctx, ids, tenant.ID, owner.ID, member.ID, suffix+2)
		groupID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02"
		insertApproverGroup(t, ctx, admin, scope.WorkspaceID(), groupID)
		exec := publishRun(t, ctx, store, scope, groupGateSrc(suffix+2, groupID), "v1")
		parkGate(t, ctx, store, scope, now(), exec)
		rec := onePending(t, ctx, approvals, scope, exec.ID)
		deleteApproverGroup(t, ctx, admin, scope.WorkspaceID(), groupID)
		stats, err := resyncWorkspace(ctx, app, store, nil, subjects, scope.WorkspaceID(), now())
		if err != nil || stats.Closed != 1 || stats.Corrected != 0 {
			t.Fatalf("stats = %+v %v", stats, err)
		}
		closed, err := approvals.Get(ctx, scope, rec.ID)
		if err != nil || closed.Status != StatusCanceled || closed.CloseReason != ReasonRequirementUnresolvable || closed.DecidedBy != "" {
			t.Fatalf("closed = %+v %v", closed, err)
		}
		assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionFailed)
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
	})
}

func subjectDecide(now time.Time, subjects SubjectDirectory, store *wfstore.Postgres) DecideInput {
	return DecideInput{
		Decision: DecisionApproved,
		Now:      now,
		Roles:    []string{"approver"},
		Subjects: subjects,
		Resolve: func(ctx context.Context, sc isolation.Scope, row Record) (policy.Requirement, error) {
			return ResolveGateRequirement(ctx, sc, store, nil, subjects, row.WorkflowID, row.WorkflowVersionID, row.NodeID, now)
		},
	}
}

func parkGate(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, now time.Time, exec wfstore.Execution) {
	t.Helper()
	gate := claimStep(t, ctx, store, scope, now, "gate")
	if _, err := store.WaitJob(ctx, scope, now, wfstore.WaitJobInput{
		JobID: gate.Job.ID, AvailableAt: now.Add(time.Hour), Approval: parkedSeed(exec),
	}); err != nil {
		t.Fatal(err)
	}
}

func insertApproverGroup(t *testing.T, ctx context.Context, db postgres.TxBeginner, workspaceID, groupID string) {
	t.Helper()
	tx, err := postgres.BeginScoped(ctx, db, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO approver_groups (workspace_id, id) VALUES ($1::uuid, $2::uuid)`, workspaceID, groupID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func insertApproverGroupMember(t *testing.T, ctx context.Context, db postgres.TxBeginner, workspaceID, groupID, userID string) {
	t.Helper()
	tx, err := postgres.BeginScoped(ctx, db, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO approver_group_members (workspace_id, group_id, user_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid)
	`, workspaceID, groupID, userID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func deleteApproverGroup(t *testing.T, ctx context.Context, db postgres.TxBeginner, workspaceID, groupID string) {
	t.Helper()
	tx, err := postgres.BeginScoped(ctx, db, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM approver_groups WHERE workspace_id = $1::uuid AND id = $2::uuid`, workspaceID, groupID)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("deleted groups = %d", tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func groupGateSrc(n int64, groupID string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: group-gate-` + formatSlug("gg", n) + `
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
        approverGroupId: ` + groupID + `
        expiresIn: PT1H
  edges: []
`
}
