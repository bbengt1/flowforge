package approval

import (
	"context"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestPostgresPendingListHidesExpired(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("pe", suffix), "PE")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("pu", suffix), "PE User")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("pw", suffix), "P", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	workflows := wfstore.NewPostgres(app)
	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: pending-filter-` + formatSlug("n", suffix) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: live
      type: flow.approval
      name: Live
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
	store := NewPostgres(app)
	live, err := store.Create(ctx, scope, CreateInput{
		WorkflowID: wf.ID, WorkflowVersionID: ver.ID, WorkflowDigest: ver.Digest,
		Requirement: policy.Requirement{
			NodeID: "live", Operation: "flow.approval", ApproverRole: "approver",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	stale, err := store.Create(ctx, scope, CreateInput{
		WorkflowID: wf.ID, WorkflowVersionID: ver.ID, WorkflowDigest: ver.Digest,
		Requirement: policy.Requirement{
			NodeID: "stale", Operation: "flow.approval", ApproverRole: "approver",
			ExpiresAt: time.Now().UTC().Add(-time.Minute),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := store.List(ctx, scope, Filter{Status: StatusPending, WorkflowID: wf.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].ID != live.ID {
		t.Fatalf("pending = %+v", pending)
	}
	all, err := store.List(ctx, scope, Filter{WorkflowID: wf.ID})
	if err != nil {
		t.Fatal(err)
	}
	sawStale := false
	for _, rec := range all {
		if rec.ID == stale.ID {
			sawStale = true
		}
	}
	if !sawStale {
		t.Fatal("unfiltered list dropped the expired row")
	}
}
