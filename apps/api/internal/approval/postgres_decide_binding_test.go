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

func TestPostgresDecideRederivesStaleApproverRole(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("rt", suffix), "RT")
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
	deadline := now().Add(time.Hour)
	if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
		JobID: gate.Job.ID, AvailableAt: deadline,
		Approval: &wfstore.ParkedApproval{
			WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
			ExecutionID: exec.ID, RequestedBy: exec.RequestedBy,
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval", ApproverRole: "approver",
		},
	}); err != nil {
		t.Fatal(err)
	}
	rec := onePending(t, ctx, approvals, scope, exec.ID)
	if rec.ApproverRole != "approver" || rec.TargetID != "" || rec.PolicyResourceID != "" {
		t.Fatalf("seed = %+v", rec)
	}
	resolve := func(ctx context.Context, sc isolation.Scope, row Record) (policy.Requirement, error) {
		return ResolveGateRequirement(ctx, sc, store, nil, row.WorkflowID, row.WorkflowVersionID, row.NodeID, now())
	}
	if _, err := approvals.Decide(ctx, approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now(), Roles: []string{"approver"}, Resolve: resolve,
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("approver decide = %v", err)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusPending || got.ApproverRole != "admin" || got.DecidedBy != "" || got.BindingFingerprint == rec.BindingFingerprint {
		t.Fatalf("after deny = %+v", got)
	}
	assertExec(t, ctx, store, scope, exec.ID, wfstore.ExecutionWaiting)
	assertStepJob(t, ctx, store, scope, exec.ID, "gate", wfstore.ExecutionWaiting, wfstore.JobWaiting)

	approved, err := approvals.Decide(ctx, approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now(), Roles: []string{"admin"}, Resolve: resolve,
	})
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != StatusApproved || approved.ApproverRole != "admin" || approved.BindingFingerprint == rec.BindingFingerprint || approved.DecidedBy != approverUser.ID {
		t.Fatalf("admin decide = %+v", approved)
	}

	exec2 := publishRun(t, ctx, store, scope, adminGateSrc(suffix+1), "v1")
	gate2 := claimStep(t, ctx, store, scope, now(), "gate")
	if _, err := store.WaitJob(ctx, scope, now(), wfstore.WaitJobInput{
		JobID: gate2.Job.ID, AvailableAt: now().Add(time.Hour),
		Approval: &wfstore.ParkedApproval{
			WorkflowID: exec2.WorkflowID, WorkflowVersionID: exec2.WorkflowVersionID, WorkflowDigest: exec2.WorkflowDigest,
			ExecutionID: exec2.ID, RequestedBy: exec2.RequestedBy,
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval", ApproverRole: "approver",
		},
	}); err != nil {
		t.Fatal(err)
	}
	stale := onePending(t, ctx, approvals, scope, exec2.ID)
	if _, err := approvals.Decide(ctx, approver, stale.ID, DecideInput{
		Decision: DecisionApproved, Now: now(), Roles: []string{"admin"},
		Resolve: func(ctx context.Context, sc isolation.Scope, row Record) (policy.Requirement, error) {
			return ResolveGateRequirement(ctx, sc, staticVersion{err: wfstore.ErrNotFound}, nil, row.WorkflowID, row.WorkflowVersionID, row.NodeID, now())
		},
	}); !errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("lookup decide = %v", err)
	}
	still, err := approvals.Get(ctx, scope, stale.ID)
	if err != nil {
		t.Fatal(err)
	}
	if still.Status != StatusPending || still.DecidedBy != "" || still.ApproverRole != "approver" {
		t.Fatalf("lookup row = %+v", still)
	}
	assertExec(t, ctx, store, scope, exec2.ID, wfstore.ExecutionWaiting)
}

func adminGateSrc(n int64) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: admin-gate-` + formatSlug("ag", n) + `
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
