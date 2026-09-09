package wfstore

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresDispatchSkipLockedAndLeaseLoss(t *testing.T) {
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

	store := NewPostgres(app)
	wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scopeA, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}

	normalized := mustNormalize(t, twoNodeDispatchYAML)
	wf, draft, err := store.Create(ctx, scopeA, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scopeA, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "e52-pg"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scopeA, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()

	var mu sync.Mutex
	var claimed []string
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			res, err := store.ClaimJob(ctx, scopeA, now, ClaimInput{WorkerID: "pg-worker", Lease: time.Minute})
			if err != nil {
				if !errors.Is(err, ErrEmptyClaim) {
					t.Errorf("claim %d: %v", n, err)
				}
				return
			}
			mu.Lock()
			claimed = append(claimed, res.Job.ID)
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	if len(claimed) != 2 || claimed[0] == claimed[1] {
		t.Fatalf("skip locked claims = %v", claimed)
	}
	if _, err := store.GetJob(ctx, scopeB, claimed[0]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace job: %v", err)
	}

	first, err := store.GetJob(ctx, scopeA, claimed[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.HeartbeatJob(ctx, scopeA, now, JobActionInput{
		JobID: first.ID, WorkerID: "pg-worker", FencingToken: first.FencingToken, Lease: time.Second,
	}); err != nil {
		t.Fatal(err)
	}
	if n, err := store.RecoverExpiredLeases(ctx, scopeA, now.Add(3*time.Second)); err != nil || n < 1 {
		t.Fatalf("recover: n=%d err=%v", n, err)
	}
	got, err := store.GetExecutionByID(ctx, scopeA, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ExecutionIndeterminate {
		t.Fatalf("lease loss status = %s", got.Status)
	}
	if _, err := store.CompleteJob(ctx, scopeA, now.Add(4*time.Second), JobActionInput{
		JobID: first.ID, WorkerID: "pg-worker", FencingToken: first.FencingToken,
	}); err == nil {
		t.Fatal("stale complete after lease loss")
	}
}

const twoNodeDispatchYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e52-two-node
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: one
      type: data.set
      name: One
      with:
        value:
          env: a
    - id: two
      type: data.set
      name: Two
      with:
        value:
          env: b
  edges: []
`
