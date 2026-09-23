package wfstore

import (
	"context"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestExecutionConcurrencyIsPerWorkspace(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scopeA, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	verA := publishFixture(t, store, scopeA, "alpha")
	verB := publishFixture(t, store, scopeB, "beta")

	first, err := store.StartExecution(ctx, scopeA, verA.WorkflowID, StartInput{VersionID: verA.ID, MaxOpen: 1, IdempotencyKey: "one"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartExecution(ctx, scopeA, verA.WorkflowID, StartInput{VersionID: verA.ID, MaxOpen: 1}); err != ErrConcurrency {
		t.Fatalf("second start = %v", err)
	}
	replay, err := store.StartExecution(ctx, scopeA, verA.WorkflowID, StartInput{VersionID: verA.ID, MaxOpen: 1, IdempotencyKey: "one"})
	if err != nil || !replay.Replayed {
		t.Fatalf("replay at the cap = %+v %v", replay, err)
	}
	if _, err := store.StartExecution(ctx, scopeB, verB.WorkflowID, StartInput{VersionID: verB.ID, MaxOpen: 1}); err != nil {
		t.Fatalf("other workspace: %v", err)
	}
	if _, err := store.CancelExecution(ctx, scopeA, first.CreatedAt, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartExecution(ctx, scopeA, verA.WorkflowID, StartInput{VersionID: verA.ID, MaxOpen: 1}); err != nil {
		t.Fatalf("after terminal: %v", err)
	}
}

func publishFixture(t *testing.T, store *Memory, scope isolation.Scope, name string) Version {
	t.Helper()
	ctx := context.Background()
	src := strings.Replace(fixtureYAML, "restart-api-rollout", name, 1)
	norm := mustNormalize(t, src)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML,
		Digest:         norm.Digest,
		Summary:        norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	return ver
}
