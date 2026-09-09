package approval

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func testDatabaseURL(t *testing.T) string {
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

func TestPostgresIsolationAndAppendOnlyEvents(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("ap", suffix), "AP")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("au", suffix), "AP User")
	if err != nil {
		t.Fatal(err)
	}
	wsA, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("a", suffix), "A", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	wsB, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("b", suffix), "B", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scopeA, err := isolation.Authorize(wsA.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}

	workflows := wfstore.NewPostgres(app)
	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: approval-pg
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Approve
      with:
        approverRole: approver
        expiresIn: PT30M
  edges: []
`))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := workflows.Create(ctx, scopeA, wfstore.CreateInput{
		NormalizedYAML: parsed.NormalizedYAML,
		Digest:         parsed.Digest,
		Summary:        parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := workflows.Publish(ctx, scopeA, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}

	store := NewPostgres(app)
	rec, err := store.Create(ctx, scopeA, CreateInput{
		WorkflowID:        wf.ID,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, scopeB, rec.ID); err != ErrNotFound {
		t.Fatalf("cross-workspace get = %v", err)
	}
	items, err := store.List(ctx, scopeB, Filter{})
	if err != nil || len(items) != 0 {
		t.Fatalf("cross-workspace list = %+v %v", items, err)
	}

	for _, table := range []string{"approvals", "approval_events"} {
		var forced bool
		if err := admin.QueryRow(ctx, `
			SELECT c.relforcerowsecurity
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relname = $1
		`, table).Scan(&forced); err != nil {
			t.Fatal(err)
		}
		if !forced {
			t.Fatalf("%s missing FORCE ROW LEVEL SECURITY", table)
		}
	}

	events, err := store.Events(ctx, scopeA, rec.ID)
	if err != nil || len(events) == 0 {
		t.Fatalf("events = %+v %v", events, err)
	}
	_, err = admin.Exec(ctx, `UPDATE approval_events SET event_type = 'rejected' WHERE id = $1::uuid`, events[0].ID)
	if err == nil {
		t.Fatal("expected append-only approval events")
	}
}

func formatSlug(prefix string, n int64) string {
	return fmt.Sprintf("%s-%d", prefix, n%100000000)
}
