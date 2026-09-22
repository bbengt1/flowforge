package observability

import (
	"context"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"
)

func TestW3CPropagationRoundTrip(t *testing.T) {
	if err := Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, span := Tracer().Start(context.Background(), "parent")
	defer span.End()
	parent, state := Capture(ctx)
	if !ValidTraceParent(parent) {
		t.Fatalf("traceparent = %q", parent)
	}
	if !strings.Contains(parent, span.SpanContext().TraceID().String()) {
		t.Fatalf("traceparent %q missing trace %s", parent, span.SpanContext().TraceID())
	}
	childCtx, child := Continue(context.Background(), parent, state, "child")
	defer child.End()
	if child.SpanContext().TraceID() != span.SpanContext().TraceID() {
		t.Fatalf("child trace = %s parent = %s", child.SpanContext().TraceID(), span.SpanContext().TraceID())
	}
	if !HasSpan(childCtx) {
		t.Fatal("continued context has no span")
	}
}

func TestTraceStateRejectsSecrets(t *testing.T) {
	samples := []string{
		"rojo=bearer super-secret-plaintext",
		"vendor=password=hunter2",
		"k=token",
		"k=authorization",
		"bad\nstate",
		strings.Repeat("a", 513),
	}
	for _, sample := range samples {
		if ValidTraceState(sample) {
			t.Fatalf("accepted tracestate %q", sample)
		}
	}
	if !ValidTraceState("") || !ValidTraceState("rojo=00f067aa0ba902b7") {
		t.Fatal("rejected a normal tracestate")
	}
	if ValidTraceParent("00-" + strings.Repeat("0", 32) + "-00f067aa0ba902b7-01") {
		t.Fatal("all-zero trace id accepted")
	}
}

func TestBusinessMetricsDropSecretLabels(t *testing.T) {
	if err := Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	NoteVault(ctx, "create", "ok")
	NoteVault(ctx, "decrypt", "error")
	NoteVault(ctx, "password=super-secret-plaintext", "ok")
	NoteVault(ctx, "use", "super-secret-plaintext")
	NoteLeaseClaim(ctx, "claimed", 20*time.Millisecond)
	NoteLeaseClaim(ctx, "bearer super-secret", 0)
	NoteJobEnqueued(ctx, 2)
	NoteQueueLeft(ctx, 1)
	NoteExecutionOutcome(ctx, "succeeded")
	NoteExecutionOutcome(ctx, "secret")
	NoteLeaseExpired(ctx, 1)

	var buf strings.Builder
	if err := WriteOTelPrometheus(&buf); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{
		"flowforge_vault_operations",
		`op="create"`,
		`op="decrypt"`,
		`result="error"`,
		"flowforge_lease_claims",
		`result="claimed"`,
		"flowforge_jobs_enqueued",
		"flowforge_queue_depth",
		"flowforge_queue_lag",
		"flowforge_execution_outcomes",
		`outcome="succeeded"`,
		"flowforge_lease_expirations",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	for _, banned := range []string{"super-secret", "password", "bearer", "authorization", "request_id"} {
		if strings.Contains(strings.ToLower(out), banned) {
			t.Fatalf("metrics leaked %q:\n%s", banned, out)
		}
	}
}

func TestInjectIgnoresUnsampledContext(t *testing.T) {
	parent, state := Capture(trace.ContextWithSpanContext(context.Background(), trace.SpanContext{}))
	if parent != "" || state != "" {
		t.Fatalf("empty span captured parent=%q state=%q", parent, state)
	}
}
