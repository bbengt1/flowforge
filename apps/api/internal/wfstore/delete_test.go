package wfstore

import (
	"context"
	"errors"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestMemoryDeleteHidesWorkflowAndReservesSlug(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := deleteScope(t)
	ver := publishFixture(t, store, scope, "restart-api-rollout")
	before, err := store.GetDraft(ctx, scope, ver.WorkflowID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.Delete(ctx, scope, ver.WorkflowID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Published || result.Name == "" || result.ID != ver.WorkflowID {
		t.Fatalf("result = %+v", result)
	}
	if _, err := store.Get(ctx, scope, ver.WorkflowID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete = %v", err)
	}
	if _, err := store.GetDraft(ctx, scope, ver.WorkflowID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("draft after delete = %v", err)
	}
	if _, err := store.ListVersions(ctx, scope, ver.WorkflowID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("versions after delete = %v", err)
	}
	if _, err := store.GetVersion(ctx, scope, ver.WorkflowID, ver.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("export version after delete = %v", err)
	}
	if _, err := store.Delete(ctx, scope, ver.WorkflowID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
	row := store.workflows[ver.WorkflowID]
	if row.draft.DefinitionYAML != before.DefinitionYAML || row.record.Status != StatusDraft || row.deletedAt == nil {
		t.Fatalf("tombstone = status %s deleted %v yaml changed %v", row.record.Status, row.deletedAt != nil, row.draft.DefinitionYAML != before.DefinitionYAML)
	}
	listed, err := store.List(ctx, scope, WorkflowListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 0 {
		t.Fatalf("list = %d", len(listed))
	}
	_, _, err = store.Create(ctx, scope, CreateInput{
		Slug:           row.record.Slug,
		NormalizedYAML: before.DefinitionYAML,
		Digest:         before.Digest,
		Summary:        before.Summary,
	})
	if !errors.Is(err, ErrSlugReserved) {
		t.Fatalf("reserved slug = %v", err)
	}
	audits, err := store.ListAuditEvents(ctx, scope, AuditListFilter{Action: "workflow.deleted"})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 1 || audits[0].ActorID != scope.ActorID() || audits[0].ResourceID != ver.WorkflowID {
		t.Fatalf("audit = %+v", audits)
	}
	if audits[0].Details["published"] != true || audits[0].Details["name"] != result.Name || audits[0].Details["workflowId"] != ver.WorkflowID {
		t.Fatalf("audit details = %+v", audits[0].Details)
	}
	if _, ok := audits[0].Details["definitionYaml"]; ok {
		t.Fatal("audit included YAML")
	}
	if audits[0].OccurredAt.IsZero() {
		t.Fatal("audit missing timestamp")
	}
}

func TestMemoryDeleteBlocksQueuedAndRunningOnly(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := deleteScope(t)
	ver := publishFixture(t, store, scope, "queued-block")
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Delete(ctx, scope, ver.WorkflowID); !errors.Is(err, ErrActiveExecutions) {
		t.Fatalf("queued delete = %v", err)
	}
	if _, err := store.Get(ctx, scope, ver.WorkflowID); err != nil {
		t.Fatalf("workflow still live: %v", err)
	}

	store2 := NewMemory()
	running := publishFixture(t, store2, scope, "running-block")
	exec, err = store2.StartExecution(ctx, scope, running.WorkflowID, StartInput{VersionID: running.ID})
	if err != nil {
		t.Fatal(err)
	}
	held := store2.executions[exec.ID]
	held.record.Status = ExecutionRunning
	store2.executions[exec.ID] = held
	if _, err := store2.Delete(ctx, scope, running.WorkflowID); !errors.Is(err, ErrActiveExecutions) {
		t.Fatalf("running delete = %v", err)
	}

	waiting := publishFixture(t, store, scope, "waiting-ok")
	exec, err = store.StartExecution(ctx, scope, waiting.WorkflowID, StartInput{VersionID: waiting.ID})
	if err != nil {
		t.Fatal(err)
	}
	held = store.executions[exec.ID]
	held.record.Status = ExecutionWaiting
	store.executions[exec.ID] = held
	if _, err := store.Delete(ctx, scope, waiting.WorkflowID); err != nil {
		t.Fatalf("waiting delete = %v", err)
	}
}

func TestDeleteAndStartCloseTheRowLockRace(t *testing.T) {
	ctx := context.Background()
	scope := deleteScope(t)

	t.Run("start then delete sees the queued execution", func(t *testing.T) {
		store := NewMemory()
		ver := publishFixture(t, store, scope, "race-start")
		started := make(chan struct{})
		errCh := make(chan error, 1)
		startCtx := WithWorkflowRowLockHook(ctx, func() {
			go func() {
				close(started)
				_, err := store.Delete(context.Background(), scope, ver.WorkflowID)
				errCh <- err
			}()
			<-started
		})
		if _, err := store.StartExecution(startCtx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID}); err != nil {
			t.Fatal(err)
		}
		if err := <-errCh; !errors.Is(err, ErrActiveExecutions) {
			t.Fatalf("delete = %v", err)
		}
	})

	t.Run("delete then start sees the tombstone", func(t *testing.T) {
		store := NewMemory()
		ver := publishFixture(t, store, scope, "race-delete")
		started := make(chan struct{})
		errCh := make(chan error, 1)
		deleteCtx := WithWorkflowRowLockHook(ctx, func() {
			go func() {
				close(started)
				_, err := store.StartExecution(context.Background(), scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
				errCh <- err
			}()
			<-started
		})
		if _, err := store.Delete(deleteCtx, scope, ver.WorkflowID); err != nil {
			t.Fatal(err)
		}
		if err := <-errCh; !errors.Is(err, ErrNotFound) {
			t.Fatalf("start = %v", err)
		}
	})
}

func deleteScope(t *testing.T) isolation.Scope {
	t.Helper()
	scope, err := isolation.AuthorizeTenancy(
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		"33333333-3333-4333-8333-333333333333",
		"bench",
	)
	if err != nil {
		t.Fatal(err)
	}
	if scope.TenantID() == "" {
		t.Fatal("tenant missing")
	}
	return scope
}
