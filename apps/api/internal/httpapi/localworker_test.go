package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
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

func TestClaimCarriesInputsStepsDoNot(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, setThenMapWorkerYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "inputs")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)

	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	client := localworker.NewHTTP(localworker.HTTPConfig{
		BaseURL:  srv.URL,
		Issuer:   admin.Issuer,
		Subject:  admin.ExternalSubject,
		WorkerID: "compose-inputs",
		Lease:    30 * time.Second,
	})

	seedRaw := claimRaw(t, h, admin, tenant, ws)
	if _, ok := seedRaw["inputs"]; ok {
		t.Fatalf("seed claim included inputs: %#v", seedRaw["inputs"])
	}
	if _, ok := seedRaw["skippedInputs"]; ok {
		t.Fatal("seed claim included skippedInputs")
	}
	seed := claimFromRaw(t, seedRaw)
	if seed.Step.NodeID != "seed" {
		t.Fatalf("claimed %s", seed.Step.NodeID)
	}
	seedDecision := localworker.Decide(seed.Step, seed.Job, seed.Inputs, seed.SkippedInputs)
	if seedDecision.Fail {
		t.Fatalf("seed %+v", seedDecision)
	}
	if err := client.Complete(t.Context(), tenant.Slug, ws.WorkbenchKey, seed, seedDecision.Output); err != nil {
		t.Fatal(err)
	}

	mapRaw := claimRaw(t, h, admin, tenant, ws)
	inputs, _ := mapRaw["inputs"].(map[string]any)
	input, _ := inputs["input"].(map[string]any)
	if input["status"] != "ready" {
		t.Fatalf("map inputs %#v", mapRaw["inputs"])
	}
	mapped := claimFromRaw(t, mapRaw)
	if mapped.Step.NodeID != "mapped" || mapped.Inputs["input"] == nil {
		t.Fatalf("parsed map claim dropped inputs: %#v", mapped.Inputs)
	}
	decision := localworker.Decide(mapped.Step, mapped.Job, mapped.Inputs, mapped.SkippedInputs)
	if decision.Fail {
		t.Fatalf("map decide %+v", decision)
	}
	if err := client.Complete(t.Context(), tenant.Slug, ws.WorkbenchKey, mapped, decision.Output); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID+"/steps", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("steps: %d %s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) == 0 {
		t.Fatal("no steps")
	}
	for _, item := range listed.Items {
		if _, ok := item["inputs"]; ok {
			t.Fatal("steps API returned inputs")
		}
		if _, ok := item["skippedInputs"]; ok {
			t.Fatal("steps API returned skippedInputs")
		}
	}
}

func claimRaw(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"compose-inputs","leaseSeconds":30}`), user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func claimFromRaw(t *testing.T, body map[string]any) localworker.Claim {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		JobToken      string                 `json:"jobToken"`
		Binding       wfstore.JobBinding     `json:"binding"`
		Job           wfstore.ExecutionJob   `json:"job"`
		Step          wfstore.ExecutionStep  `json:"step"`
		Execution     wfstore.Execution      `json:"execution"`
		Inputs        map[string]any         `json:"inputs"`
		SkippedInputs []wfstore.SkippedInput `json:"skippedInputs"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	return localworker.Claim{
		JobToken:      payload.JobToken,
		Binding:       payload.Binding,
		Job:           payload.Job,
		Step:          payload.Step,
		Execution:     payload.Execution,
		Inputs:        payload.Inputs,
		SkippedInputs: payload.SkippedInputs,
	}
}

const setThenMapWorkerYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: worker-set-map
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: seed
      type: data.set
      name: Seed
      with:
        value:
          status: ready
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          status: status
  edges:
    - from: seed.result
      to: mapped.input
`
