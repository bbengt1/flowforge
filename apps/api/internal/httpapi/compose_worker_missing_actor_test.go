package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// TestComposeWorkerFailsManualRunWithNoRequester is #628 F1, Terry's repro:
// a manual run whose requested_by is NULL, drained by the compose worker
// over the HTTP claim. The claim fails the run with missing_actor before
// any node runs; the worker never gets a job for it.
func TestComposeWorkerFailsManualRunWithNoRequester(t *testing.T) {
	th := newTargetsHarness(t)
	worker := th.bindComposeWorker()
	execID := th.startYAML(blankDraftYAML)
	if _, err := th.admin.Exec(th.ctx, `UPDATE executions SET requested_by = NULL WHERE id = $1::uuid`, execID); err != nil {
		t.Fatal(err)
	}

	// The raw claim answers 204: there is no job for any worker.
	if rec := th.do(worker, http.MethodPost, "/api/v1/jobs/claim", `{"workerId":"compose-f1","leaseSeconds":5}`); rec.Code != http.StatusNoContent {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}

	// The compose worker's own loop also finds nothing to run.
	srv := httptest.NewServer(th.h)
	defer srv.Close()
	client := localworker.NewHTTP(localworker.HTTPConfig{
		BaseURL: srv.URL, Issuer: worker.Issuer, Subject: worker.ExternalSubject,
		WorkerID: "compose-f1", Lease: 30 * time.Second,
	})
	if n, err := localworker.NewRunner(client, localworker.Config{WorkerID: "compose-f1"}).Drain(th.ctx); err != nil || n != 0 {
		t.Fatalf("drain = %d %v", n, err)
	}

	got := th.execution(execID)
	if got.Status != wfstore.ExecutionFailed || got.StatusReason != wfstore.ReasonMissingActor {
		t.Fatalf("execution = %s %s", got.Status, got.StatusReason)
	}

	rec := th.do(th.owner, http.MethodGet, "/api/v1/executions/"+execID+"/steps", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("steps: %d %s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Items []wfstore.ExecutionStep `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	sawSeed := false
	for _, step := range listed.Items {
		if step.StartedAt != nil || step.FencingToken != 0 || len(step.Output) != 0 || step.Status == wfstore.ExecutionSucceeded {
			t.Fatalf("step %s ran: %+v", step.NodeID, step)
		}
		if step.NodeID == "seed" {
			sawSeed = true
			if step.Status != wfstore.ExecutionFailed || step.Error["code"] != wfstore.ReasonMissingActor || step.Error["message"] != wfstore.MissingActorDetail {
				t.Fatalf("seed = %s %+v", step.Status, step.Error)
			}
		}
	}
	if !sawSeed {
		t.Fatalf("no seed step: %s", rec.Body.String())
	}

	var claimed int
	if err := th.admin.QueryRow(th.ctx, `SELECT count(*) FROM execution_jobs WHERE execution_id = $1::uuid AND (fencing_token > 0 OR worker_id IS NOT NULL)`, execID).Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	if claimed != 0 {
		t.Fatalf("%d jobs were handed to a worker", claimed)
	}
}
