package wfstore

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

// stampJobs copies the current W3C span onto each new job. An absent
// or invalid span leaves the columns empty; dispatch still proceeds.
func stampJobs(ctx context.Context, jobs []ExecutionJob) {
	parent, state := observability.Capture(ctx)
	if parent == "" {
		return
	}
	for i := range jobs {
		jobs[i].TraceParent = parent
		jobs[i].TraceState = state
	}
}
