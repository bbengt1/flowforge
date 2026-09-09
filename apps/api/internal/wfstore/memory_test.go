package wfstore

import (
	"context"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const fixtureYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: kubernetes.apply
      name: Restart API
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
  edges: []
`

func TestMemoryDraftPublishPinAndRestore(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	other, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}

	normalized := mustNormalize(t, fixtureYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if draft.Revision != 1 || wf.Status != StatusDraft {
		t.Fatalf("create: %+v %+v", wf, draft)
	}

	if _, err := store.Get(ctx, other, wf.ID); err != ErrNotFound {
		t.Fatalf("cross-workspace get: %v", err)
	}
	if _, err := store.StartExecution(ctx, scope, wf.ID, StartInput{}); err != ErrDraftNotRunnable {
		t.Fatalf("draft run: %v", err)
	}

	edited := strings.Replace(fixtureYAML, "name: Restart API", "name: Restart API v2", 1)
	norm2 := mustNormalize(t, edited)
	if _, _, err := store.SaveDraft(ctx, scope, wf.ID, SaveInput{
		ExpectedRevision: 99,
		NormalizedYAML:   norm2.NormalizedYAML,
		Digest:           norm2.Digest,
		Summary:          norm2.Summary,
	}); err != ErrRevisionConflict {
		t.Fatalf("stale save: %v", err)
	}
	wf, draft, err = store.SaveDraft(ctx, scope, wf.ID, SaveInput{
		ExpectedRevision: 1,
		NormalizedYAML:   norm2.NormalizedYAML,
		Digest:           norm2.Digest,
		Summary:          norm2.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if draft.Revision != 2 || draft.Summary.Nodes[0].Name != "Restart API v2" {
		t.Fatalf("save: %+v", draft)
	}

	wf, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 2, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	if wf.Status != StatusPublished || ver.VersionNumber != 1 || ver.Digest != draft.Digest {
		t.Fatalf("publish: %+v %+v", wf, ver)
	}
	if _, _, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 2}); err != ErrDuplicateVersion {
		t.Fatalf("duplicate publish: %v", err)
	}

	exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	pinnedDigest := exec.WorkflowDigest

	editedAgain := strings.Replace(fixtureYAML, "name: Restart API", "name: Restart API v3", 1)
	norm3 := mustNormalize(t, editedAgain)
	if _, _, err := store.SaveDraft(ctx, scope, wf.ID, SaveInput{
		ExpectedRevision: 2,
		NormalizedYAML:   norm3.NormalizedYAML,
		Digest:           norm3.Digest,
		Summary:          norm3.Summary,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetExecution(ctx, scope, wf.ID, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkflowDigest != pinnedDigest || got.WorkflowVersionID != ver.ID {
		t.Fatalf("pin drifted: %+v", got)
	}
	draft, err = store.GetDraft(ctx, scope, wf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if draft.Digest == pinnedDigest {
		t.Fatal("draft should have moved on from the pinned digest")
	}

	diff, err := store.Compare(ctx, scope, wf.ID, CompareRef{Kind: RefVersion, VersionID: ver.ID}, CompareRef{Kind: RefDraft})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Equal || diff.DigestMatch {
		t.Fatalf("expected draft/version mismatch: %+v", diff)
	}

	_, restored, err := store.Restore(ctx, scope, wf.ID, RestoreInput{VersionID: ver.ID, ExpectedRevision: 3})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Digest != ver.Digest || restored.Revision != 4 {
		t.Fatalf("restore: %+v", restored)
	}
}

func TestMemoryIdempotentStartAndRedaction(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	normalized := mustNormalize(t, fixtureYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}

	first, err := store.StartExecution(ctx, scope, wf.ID, StartInput{
		VersionID:      ver.ID,
		IdempotencyKey: "run-1",
		Input:          map[string]any{"name": "api", "token": "super-secret-token"},
		CorrelationID:  "caller-request-16",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Replayed || first.Status != ExecutionQueued {
		t.Fatalf("first = %+v", first)
	}
	if first.Input["token"] != redactedMarker || first.Input["name"] != "api" {
		t.Fatalf("input not redacted: %#v", first.Input)
	}
	steps, err := store.ListSteps(ctx, scope, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 1 || steps[0].NodeID != "restart" {
		t.Fatalf("steps = %+v", steps)
	}
	jobs, err := store.ListJobs(ctx, scope, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].ExecutionStepID != steps[0].ID {
		t.Fatalf("jobs = %+v", jobs)
	}

	replay, err := store.StartExecution(ctx, scope, wf.ID, StartInput{
		VersionID:      ver.ID,
		IdempotencyKey: "run-1",
		Input:          map[string]any{"name": "api", "token": "super-secret-token"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || replay.ID != first.ID {
		t.Fatalf("replay = %+v", replay)
	}
	listed, err := store.ListExecutions(ctx, scope, ExecutionListFilter{WorkflowID: wf.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 {
		t.Fatalf("list repeated work: %+v", listed)
	}

	if _, err := store.StartExecution(ctx, scope, wf.ID, StartInput{
		VersionID:      ver.ID,
		IdempotencyKey: "run-1",
		Input:          map[string]any{"name": "other"},
	}); err != ErrIdempotencyConflict {
		t.Fatalf("mismatch: %v", err)
	}

	audits, err := store.ListAuditEvents(ctx, scope, AuditListFilter{ResourceType: "execution", ResourceID: first.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 2 {
		t.Fatalf("audit = %+v", audits)
	}
	outcomes := map[string]bool{}
	for _, ev := range audits {
		if ev.Action != "execution.start" {
			t.Fatalf("audit = %+v", ev)
		}
		if ev.Details["workflowDigest"] != ver.Digest || ev.Details["workflowVersionId"] != ver.ID {
			t.Fatalf("start audit missing pin: %#v", ev.Details)
		}
		if ev.CorrelationID == "" && ev.Details["correlationId"] == "" {
			t.Fatalf("start audit missing correlation: %#v", ev)
		}
		outcomes[ev.Outcome] = true
		if _, ok := ev.Details["token"]; ok {
			t.Fatalf("audit leaked token: %#v", ev.Details)
		}
	}
	if !outcomes["created"] || !outcomes["replayed"] {
		t.Fatalf("outcomes = %#v", outcomes)
	}
}

func mustNormalize(t *testing.T, src string) *workflow.Result {
	t.Helper()
	res, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("normalize: %v", errs)
	}
	return res
}
