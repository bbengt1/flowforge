package runner

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #651: Config.Now is the single test-only clock for Runner.

func TestRunnerClockDefaultIsRealUTC(t *testing.T) {
	q := &StoreQueue{}
	d := &Dispatcher{}
	r := NewRunner(q, d, Config{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	before := time.Now()
	got := r.now()
	if got.Location() != time.UTC || got.Before(before.Add(-time.Second)) || got.After(time.Now().Add(time.Second)) {
		t.Fatalf("default now = %v", got)
	}
	if q.Now != nil || d.Now != nil {
		t.Fatal("default path must not install a clock on queue or dispatcher")
	}
}

func TestRunnerClockHookIsUTCAndShared(t *testing.T) {
	loc := time.FixedZone("X", 5*3600)
	fake := time.Date(2030, 1, 2, 3, 4, 5, 0, loc)
	q := &StoreQueue{}
	d := &Dispatcher{}
	r := NewRunner(q, d, Config{Now: func() time.Time { return fake }})
	for name, f := range map[string]func() time.Time{"runner": r.now, "queue": q.now, "dispatcher": d.now} {
		got := f()
		if !got.Equal(fake) || got.Location() != time.UTC {
			t.Fatalf("%s now = %v", name, got)
		}
	}
	// An explicit queue clock is not overridden.
	own := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	q2 := &StoreQueue{Now: func() time.Time { return own }}
	NewRunner(q2, nil, Config{Now: func() time.Time { return fake }})
	if !q2.now().Equal(own) {
		t.Fatal("queue clock overridden")
	}
}

func TestRunnerClockHookMovesDelayAndApprovalDeadlines(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatRunnerSlug("ct", suffix), "CT")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatRunnerSlug("cu", suffix), "Clock")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatRunnerSlug("cw", suffix), "C", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	approvals := approval.NewPostgres(app)

	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: runner-clock-` + formatRunnerSlug("k", suffix) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Pause
      with:
        duration: PT2H
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1M
  edges:
    - from: pause.result
      to: gate.request
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

	clock := time.Now().UTC()
	t0 := clock
	// Only Config.Now is set: the queue clock comes from the hook.
	queue := &StoreQueue{
		Workflows: store,
		JobKey:    wfstore.NewJobBindingKey(),
		WorkerID:  "production-runner",
		Lease:     time.Minute,
		Fixed:     []Workspace{{ID: ws.ID, ActorID: user.ID}},
	}
	loop := NewRunner(queue, nil, Config{
		WorkerID: "production-runner",
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:      func() time.Time { return clock },
	})

	if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
		t.Fatalf("delay park n=%d err=%v", n, err)
	}
	jobs, err := store.ListJobs(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	parked := false
	for _, j := range jobs {
		if j.Status == wfstore.JobWaiting && j.AvailableAt.Sub(t0.Add(2*time.Hour)).Abs() <= time.Second {
			parked = true
		}
	}
	if !parked {
		t.Fatalf("delay not parked until fake t0+2h: %+v", jobs)
	}
	if n, err := loop.PollOnce(ctx); err != nil || n != 0 {
		t.Fatalf("delay must hold before its deadline: n=%d err=%v", n, err)
	}

	clock = t0.Add(2*time.Hour + time.Second)
	// Past the fake deadline the store releases the delay at claim time,
	// so this pass claims and parks the gate.
	if n, err := loop.PollOnce(ctx); err != nil || n != 1 {
		t.Fatalf("gate park after fake delay n=%d err=%v", n, err)
	}
	items, err := approvals.List(ctx, scope, approval.Filter{ExecutionID: exec.ID})
	if err != nil || len(items) != 1 || items[0].Status != approval.StatusPending {
		t.Fatalf("approvals = %+v %v", items, err)
	}
	if want := clock.Add(time.Minute); items[0].ExpiresAt.Sub(want).Abs() > time.Second {
		t.Fatalf("approval expires %s want %s (fake clock)", items[0].ExpiresAt, want)
	}

	clock = clock.Add(2 * time.Minute)
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := approvals.Get(ctx, scope, items[0].ID)
	if err != nil || got.Status == approval.StatusPending {
		t.Fatalf("approval after fake expiry = %+v %v", got, err)
	}
}
