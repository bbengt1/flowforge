package wfstore

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func TestQueuedJobCarriesW3CTraceAndHidesItFromJSON(t *testing.T) {
	if err := observability.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, span := observability.Tracer().Start(context.Background(), "execution.start")
	defer span.End()

	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	normalized := mustNormalize(t, fixtureYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := store.ListJobs(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("jobs = %d", len(jobs))
	}
	if !strings.Contains(jobs[0].TraceParent, span.SpanContext().TraceID().String()) {
		t.Fatalf("job traceparent = %q want trace %s", jobs[0].TraceParent, span.SpanContext().TraceID())
	}
	raw, err := json.Marshal(jobs[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), jobs[0].TraceParent) || strings.Contains(string(raw), "traceparent") {
		t.Fatalf("job JSON exposed trace context: %s", raw)
	}

	claimed, err := store.ClaimJob(ctx, scope, jobs[0].AvailableAt, ClaimInput{WorkerID: "worker-1"})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Job.TraceParent != jobs[0].TraceParent {
		t.Fatalf("claim dropped traceparent: %q", claimed.Job.TraceParent)
	}
}
