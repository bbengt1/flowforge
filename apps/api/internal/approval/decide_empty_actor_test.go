package approval

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Decide with an empty actor is refused with ErrForbidden before any
// write: a fresh approval is not decided, and one past its deadline is not
// expired (the freshness correction would otherwise commit). No event is
// recorded on either store.
func emptyActorCases(rec Record, now time.Time) []struct {
	name string
	in   DecideInput
} {
	resolve := func(context.Context, isolation.Scope, Record) (policy.Requirement, error) {
		return StoredRequirement(rec), nil
	}
	return []struct {
		name string
		in   DecideInput
	}{
		{"fresh approval", DecideInput{Decision: "approve", Now: now.Add(time.Minute), Roles: []string{"approver"}, Resolve: resolve}},
		{"past its deadline", DecideInput{Decision: "approve", Now: now.Add(2 * time.Hour), Roles: []string{"approver"}, Resolve: resolve}},
	}
}

type decideStore interface {
	Decide(ctx context.Context, scope isolation.Scope, id string, in DecideInput) (Record, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Record, error)
	Events(ctx context.Context, scope isolation.Scope, id string) ([]Event, error)
}

func assertEmptyActorRefused(t *testing.T, store decideStore, scope isolation.Scope, rec Record, now time.Time) {
	t.Helper()
	ctx := context.Background()
	nobody, err := isolation.Authorize(scope.WorkspaceID(), "")
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.Events(ctx, scope, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range emptyActorCases(rec, now) {
		if _, err := store.Decide(ctx, nobody, rec.ID, c.in); !errors.Is(err, ErrForbidden) {
			t.Fatalf("%s: empty-actor decide = %v, want ErrForbidden", c.name, err)
		}
		got, err := store.Get(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusPending || got.DecidedBy != "" || got.DecidedAt != nil {
			t.Fatalf("%s: record changed: status=%s decidedBy=%q", c.name, got.Status, got.DecidedBy)
		}
		after, err := store.Events(ctx, scope, rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(after) != len(before) {
			t.Fatalf("%s: %d event(s) written", c.name, len(after)-len(before))
		}
	}
}

func TestMemoryDecideRefusesEmptyActor(t *testing.T) {
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	rec, err := store.Create(context.Background(), scope, CreateInput{
		WorkflowID:        "44444444-4444-4444-8444-444444444444",
		WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest:    "sha256:" + strings.Repeat("a", 64),
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertEmptyActorRefused(t, store, scope, rec, now)
}

func TestPostgresDecideRefusesEmptyActor(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("ea", suffix), "EA")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("eu", suffix), "EA User")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("e", suffix), "E", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: approval-empty-actor
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
	workflows := wfstore.NewPostgres(app)
	wf, draft, err := workflows.Create(ctx, scope, wfstore.CreateInput{NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := workflows.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	store := NewPostgres(app)
	now := time.Now().UTC()
	rec, err := store.Create(ctx, scope, CreateInput{
		WorkflowID:        wf.ID,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertEmptyActorRefused(t, store, scope, rec, now)
}

// requireEnabledDeciderTx itself treats an empty actor as forbidden.
func TestRequireEnabledDeciderRefusesEmptyActor(t *testing.T) {
	if err := requireEnabledDeciderTx(context.Background(), nil, ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("empty actor = %v, want ErrForbidden", err)
	}
}
