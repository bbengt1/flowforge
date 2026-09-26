package wfstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestDeleteRacesClaimWithExpiredLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
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
	ws, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(ws, userID)
	if err != nil {
		t.Fatal(err)
	}

	const rounds = 20
	for i := 0; i < rounds; i++ {
		normalized := mustNormalize(t, strings.Replace(fixtureYAML, "name: restart-api-rollout", fmt.Sprintf("name: race-%d", i), 1))
		wf, draft, err := store.Create(ctx, scope, CreateInput{
			Slug:           fmt.Sprintf("race-%d-%d", time.Now().UnixNano()%100000, i),
			NormalizedYAML: normalized.NormalizedYAML,
			Digest:         normalized.Digest,
			Summary:        normalized.Summary,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
		if err != nil {
			t.Fatal(err)
		}
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.ClaimJob(ctx, scope, time.Now().UTC(), ClaimInput{WorkerID: "race-worker", Lease: time.Minute}); err != nil {
			t.Fatalf("round %d claim: %v", i, err)
		}
		if _, err := admin.Exec(ctx, `
			UPDATE execution_jobs
			   SET lease_expires_at = now() - interval '1 minute'
			 WHERE execution_id = $1::uuid
			   AND status = 'claimed'
		`, exec.ID); err != nil {
			t.Fatal(err)
		}

		var wg sync.WaitGroup
		errCh := make(chan error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, deleteErr := store.Delete(ctx, scope, wf.ID)
			if deleteErr != nil && !errors.Is(deleteErr, ErrActiveExecutions) {
				errCh <- deleteErr
			}
		}()
		go func() {
			defer wg.Done()
			_, claimErr := store.ClaimJob(ctx, scope, time.Now().UTC(), ClaimInput{WorkerID: "race-recover", Lease: time.Minute})
			if claimErr != nil && !errors.Is(claimErr, ErrEmptyClaim) {
				errCh <- claimErr
			}
		}()
		wg.Wait()
		close(errCh)
		for raceErr := range errCh {
			if strings.Contains(strings.ToLower(raceErr.Error()), "deadlock") {
				t.Fatalf("round %d deadlock: %v", i, raceErr)
			}
			t.Fatalf("round %d: %v", i, raceErr)
		}

		got, err := store.GetExecutionByID(ctx, scope, exec.ID)
		if err != nil {
			t.Fatalf("round %d execution: %v", i, err)
		}
		if !isTerminalExecution(got.Status) {
			t.Fatalf("round %d status = %s", i, got.Status)
		}
		jobs, err := store.ListJobs(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, job := range jobs {
			if job.Status == JobClaimed || job.Status == JobRunning {
				t.Fatalf("round %d job still in flight: %+v", i, job)
			}
		}
	}
}
