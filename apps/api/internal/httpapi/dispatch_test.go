package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestDispatchClaimFenceCancelAndLeaseLoss(t *testing.T) {
	var frozen atomic.Int64
	base := time.Date(2026, 9, 9, 5, 0, 0, 0, time.UTC).UnixNano()
	frozen.Store(base)
	h, admin := seededWorkspaceWithClock(t, func() time.Time {
		return time.Unix(0, frozen.Load()).UTC()
	})
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e52")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)

	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e52-viewer","role_keys":["viewer"]}`)
	operator := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e52-operator","role_keys":["operator"]}`)

	t.Run("viewer cannot cancel or claim", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec.ID+"/cancel", []byte(`{}`), viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"viewer-worker"}`), viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	claimBody, _ := json.Marshal(map[string]any{"workerId": "worker-a", "leaseSeconds": 1})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", claimBody, operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}
	var claimed claimJobResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if !claimed.Claimed || claimed.JobToken == "" || claimed.Binding.WorkspaceID != ws.ID {
		t.Fatalf("claim = %+v", claimed)
	}
	if err := wfstore.AuthorizeJobBinding(claimed.Binding, ws.ID, pub.Version.ID, claimed.Execution.WorkflowDigest, time.Unix(0, frozen.Load()).UTC()); err != nil {
		t.Fatalf("worker rejected job: %v", err)
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", claimBody, operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("single claim: %d %s", rec.Code, rec.Body.String())
	}

	providerCalls := 0
	hb, _ := json.Marshal(map[string]any{
		"jobToken": claimed.JobToken, "workerId": "worker-a", "fencingToken": claimed.Job.FencingToken, "leaseSeconds": 1,
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/"+claimed.Job.ID+"/heartbeat", hb, operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d %s", rec.Code, rec.Body.String())
	}
	providerCalls++

	tampered := claimed.JobToken[:len(claimed.JobToken)-2] + "aa"
	bad, _ := json.Marshal(map[string]any{"jobToken": tampered, "workerId": "worker-a", "fencingToken": claimed.Job.FencingToken})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/"+claimed.Job.ID+"/complete", bad, operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	stale, _ := json.Marshal(map[string]any{"jobToken": claimed.JobToken, "workerId": "worker-a", "fencingToken": 99})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/"+claimed.Job.ID+"/complete", stale, operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")

	otherRec := httptest.NewRecorder()
	otherReq := identifiedRequest(http.MethodPost, "/api/v1/workspaces", strings.NewReader(`{"tenant_slug":"acme","workbench_key":"other-e52","name":"Other"}`))
	otherReq.Header.Set(headerIssuer, admin.Issuer)
	otherReq.Header.Set(headerSubject, admin.ExternalSubject)
	otherReq.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(otherRec, otherReq)
	if otherRec.Code != http.StatusCreated {
		t.Fatalf("other workspace: %d %s", otherRec.Code, otherRec.Body.String())
	}
	cross, _ := json.Marshal(map[string]any{"jobToken": claimed.JobToken, "workerId": "worker-a", "fencingToken": claimed.Job.FencingToken})
	rec = httptest.NewRecorder()
	req = identifiedRequest(http.MethodPost, "/api/v1/jobs/"+claimed.Job.ID+"/complete", strings.NewReader(string(cross)))
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "other-e52")
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	frozen.Store(base + int64(3*time.Second))
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/recover", []byte(`{}`), operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("recover: %d %s", rec.Code, rec.Body.String())
	}
	var recovered recoverJobsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &recovered); err != nil {
		t.Fatal(err)
	}
	if recovered.Recovered != 1 {
		t.Fatalf("recovered = %d", recovered.Recovered)
	}

	done, _ := json.Marshal(map[string]any{
		"jobToken": claimed.JobToken, "workerId": "worker-a", "fencingToken": claimed.Job.FencingToken,
		"output": map[string]any{"ok": true},
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/"+claimed.Job.ID+"/complete", done, operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	var detail executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Status != wfstore.ExecutionIndeterminate {
		t.Fatalf("status after lease loss = %s", detail.Status)
	}
	if providerCalls != 1 {
		t.Fatalf("duplicate provider calls: %d", providerCalls)
	}

	t.Run("cancel is idempotent and authorized", func(t *testing.T) {
		exec2 := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec2.ID+"/cancel", []byte(`{}`), operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("cancel: %d %s", rec.Code, rec.Body.String())
		}
		var first executionResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
			t.Fatal(err)
		}
		if first.Status != wfstore.ExecutionCanceled {
			t.Fatalf("cancel status = %s", first.Status)
		}
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec2.ID+"/cancel", []byte(`{}`), operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("cancel again: %d %s", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec2.ID+"/cancel", []byte(`{}`), viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("retry failed core node", func(t *testing.T) {
		exec3 := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", claimBody, operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
		}
		var c3 claimJobResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &c3); err != nil {
			t.Fatal(err)
		}
		hb, _ := json.Marshal(map[string]any{"jobToken": c3.JobToken, "workerId": "worker-a", "fencingToken": c3.Job.FencingToken, "leaseSeconds": 30})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/jobs/"+c3.Job.ID+"/heartbeat", hb, operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("heartbeat: %d %s", rec.Code, rec.Body.String())
		}
		fail, _ := json.Marshal(map[string]any{"jobToken": c3.JobToken, "workerId": "worker-a", "fencingToken": c3.Job.FencingToken, "error": map[string]any{"code": "boom"}})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/jobs/"+c3.Job.ID+"/fail", fail, operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("fail: %d %s", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec3.ID+"/steps/"+c3.Step.ID+"/retry", []byte(`{}`), operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("retry: %d %s", rec.Code, rec.Body.String())
		}
		var retried retryResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &retried); err != nil {
			t.Fatal(err)
		}
		if retried.Step.Attempt != 2 || retried.Job.Status != wfstore.JobQueued {
			t.Fatalf("retry = %+v %+v", retried.Step, retried.Job)
		}
	})
}

func TestDispatchHostWorkspaceRejected(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"w","workspaceId":"`+ws.ID+`"}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
}
