package observability

import (
	"context"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Label sets are closed. Callers cannot put request ids, workspace
// ids, credential ids, or secret material on a business metric.

var leaseResults = map[string]struct{}{
	"claimed": {},
	"empty":   {},
	"error":   {},
}

var executionOutcomes = map[string]struct{}{
	"succeeded":     {},
	"failed":        {},
	"canceled":      {},
	"indeterminate": {},
	"queued":        {},
	"waiting":       {},
}

var vaultOps = map[string]struct{}{
	"create":  {},
	"rotate":  {},
	"use":     {},
	"decrypt": {},
}

var vaultResults = map[string]struct{}{
	"ok":    {},
	"error": {},
}

// NoteJobEnqueued records n newly queued jobs and raises the process
// queue-depth gauge. n <= 0 is ignored.
func NoteJobEnqueued(ctx context.Context, n int) {
	if n <= 0 || instruments == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	instruments.jobsEnqueued.Add(ctx, int64(n))
	instruments.queueDepth.Add(ctx, int64(n))
}

// NoteQueueLeft lowers the process queue-depth gauge by n jobs that
// left status=queued. n <= 0 is ignored.
func NoteQueueLeft(ctx context.Context, n int) {
	if n <= 0 || instruments == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	instruments.queueDepth.Add(ctx, -int64(n))
}

// NoteLeaseClaim records one claim attempt. result must be claimed,
// empty, or error. Lag is recorded only for a successful claim.
func NoteLeaseClaim(ctx context.Context, result string, lag time.Duration) {
	if instruments == nil {
		return
	}
	if _, ok := leaseResults[result]; !ok {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	instruments.leaseClaims.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
	if result == "claimed" {
		if lag < 0 {
			lag = 0
		}
		instruments.queueLag.Record(ctx, lag.Seconds())
	}
}

// NoteLeaseExpired records n jobs moved to indeterminate because their
// lease ended before a worker finished them.
func NoteLeaseExpired(ctx context.Context, n int) {
	if n <= 0 || instruments == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	instruments.leaseExpirations.Add(ctx, int64(n))
}

// NoteExecutionOutcome records a terminal outcome. Unknown strings are
// dropped so a caller cannot invent a label.
func NoteExecutionOutcome(ctx context.Context, outcome string) {
	if instruments == nil {
		return
	}
	if _, ok := executionOutcomes[outcome]; !ok {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	instruments.executionOutcomes.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
}

// NoteVault records one vault operation. op is create, rotate, use, or
// decrypt. result is ok or error. Anything else is dropped.
func NoteVault(ctx context.Context, op, result string) {
	if instruments == nil {
		return
	}
	if _, ok := vaultOps[op]; !ok {
		return
	}
	if _, ok := vaultResults[result]; !ok {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	instruments.vaultOps.Add(ctx, 1, metric.WithAttributes(
		attribute.String("op", op),
		attribute.String("result", result),
	))
}
