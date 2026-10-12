//go:build fftest

package runner

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #651 fixture 07: test.flaky failTimes: 1 fails attempt 1, and a retry
// (retrySafe) succeeds on attempt 2. Pure function of attempt number.
func TestFlakyFailsThenSucceedsOnRetry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
	tenant, err := ids.CreateTenant(ctx, formatRunnerSlug("ft", suffix), "FT")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("fu", suffix), "Flaky")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatRunnerSlug("fw", suffix), "F", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: runner-flaky-` + formatRunnerSlug("f", suffix) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: flaky
      type: test.flaky
      name: Flaky
      with:
        failTimes: 1
  edges: []
`))
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
	queue := &StoreQueue{
		Workflows: store, JobKey: wfstore.NewJobBindingKey(), WorkerID: "production-runner",
		Lease: time.Minute, Fixed: []Workspace{{ID: ws.ID, ActorID: user.ID}},
	}
	loop := NewRunner(queue, &Dispatcher{}, Config{WorkerID: "production-runner", Log: slog.New(slog.NewTextHandler(io.Discard, nil))})

	if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
		t.Fatalf("attempt 1 n=%d err=%v", n, err)
	}
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil || len(steps) != 1 || steps[0].Status != wfstore.ExecutionFailed || steps[0].Attempt != 1 {
		t.Fatalf("after attempt 1: %+v %v", steps, err)
	}
	if code, _ := steps[0].Error["code"].(string); code != workflow.CodeTestFlakyFailure {
		t.Fatalf("error = %+v", steps[0].Error)
	}
	if _, err := store.RetryStep(ctx, scope, time.Now().UTC(), exec.ID, steps[0].ID); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
		t.Fatalf("attempt 2 n=%d err=%v", n, err)
	}
	steps, err = store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	ok := false
	for _, s := range steps {
		if s.Attempt == 2 && s.Status == wfstore.ExecutionSucceeded {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("attempt 2 did not succeed: %+v", steps)
	}
}
