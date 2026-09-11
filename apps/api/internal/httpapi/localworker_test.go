package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const blankDraftYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: blank-draft
spec:
  description: Editable blank draft created from the workflow home.
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: seed
      type: data.set
      name: Seed value
      with:
        value:
          status: ready
    - id: done
      type: flow.stop
      name: Stop
  edges:
    - from: seed.result
      to: done.input
`

func TestLocalWorkerClaimsBlankDraftPastQueued(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, blankDraftYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "local-worker")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
	if exec.Status != wfstore.ExecutionQueued {
		t.Fatalf("start status = %s", exec.Status)
	}

	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	client := localworker.NewHTTP(localworker.HTTPConfig{
		BaseURL:  srv.URL,
		Issuer:   admin.Issuer,
		Subject:  admin.ExternalSubject,
		WorkerID: "compose-local-test",
		Lease:    30 * time.Second,
	})
	runner := localworker.NewRunner(client, localworker.Config{WorkerID: "compose-local-test"})
	n, err := runner.Drain(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatalf("expected the worker to claim at least one job, got %d", n)
	}

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	var detail executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Status == wfstore.ExecutionQueued {
		t.Fatalf("execution stayed queued: %+v jobs=%+v", detail.Execution, detail.Jobs)
	}
	if detail.StatusReason == StatusReasonNoWorker {
		t.Fatalf("claimed run should not report no-worker: %+v", detail)
	}
	if detail.Status != wfstore.ExecutionSucceeded {
		t.Fatalf("status after drain = %s claimed=%d body=%s", detail.Status, n, rec.Body.String())
	}
}

func TestExecutionQueuedNoWorkerReason(t *testing.T) {
	var frozen atomic.Int64
	frozen.Store(time.Now().UTC().UnixNano())
	h, admin := seededWorkspaceWithClock(t, func() time.Time {
		return time.Unix(0, frozen.Load()).UTC()
	})
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, blankDraftYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "no-worker")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	var fresh executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &fresh); err != nil {
		t.Fatal(err)
	}
	if fresh.StatusReason != "" {
		t.Fatalf("fresh queued run should not yet report no-worker: %+v", fresh)
	}

	if len(fresh.Jobs) == 0 {
		t.Fatal("expected queued jobs")
	}
	frozen.Store(fresh.Jobs[0].AvailableAt.Add(DefaultQueuedNoWorkerAfter + time.Second).UnixNano())
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get aged: %d %s", rec.Code, rec.Body.String())
	}
	var aged executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &aged); err != nil {
		t.Fatal(err)
	}
	if aged.Status != wfstore.ExecutionQueued || aged.StatusReason != StatusReasonNoWorker {
		t.Fatalf("aged queued run = status=%s reason=%q", aged.Status, aged.StatusReason)
	}
}

func TestQueuedUnclaimedReason(t *testing.T) {
	now := time.Now().UTC()
	exec := wfstore.Execution{Status: wfstore.ExecutionQueued}
	jobs := []wfstore.ExecutionJob{{
		Status:      wfstore.JobQueued,
		AvailableAt: now.Add(-DefaultQueuedNoWorkerAfter - time.Second),
	}}
	if got := queuedUnclaimedReason(exec, jobs, now); got != StatusReasonNoWorker {
		t.Fatalf("got %q", got)
	}
	if got := queuedUnclaimedReason(exec, jobs, now.Add(-time.Hour)); got != "" {
		t.Fatalf("fresh = %q", got)
	}
	exec.Status = wfstore.ExecutionRunning
	if got := queuedUnclaimedReason(exec, jobs, now); got != "" {
		t.Fatalf("running = %q", got)
	}
}
