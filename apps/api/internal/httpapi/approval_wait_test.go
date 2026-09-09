package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const approvalWaitYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e103-wait
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Approve
      with:
        approverRole: approver
        expiresIn: PT15M
  edges: []
`

func approvalWaitYAMLNamed(name string) string {
	return strings.Replace(approvalWaitYAML, "e103-wait", name, 1)
}

func TestDurableApprovalWaitResumeExpirySoDAndInvalidate(t *testing.T) {
	var frozen atomic.Int64
	base := time.Now().UTC().Add(time.Second)
	frozen.Store(base.UnixNano())
	h, admin := seededWorkspaceWithClock(t, func() time.Time {
		return time.Unix(0, frozen.Load()).UTC()
	})
	ws, tenant := currentWorkspace(t, h, admin)

	pol := createOpsResource(t, h, admin, tenant, ws, "policies", "approval-gate", map[string]any{
		"kind": "approval",
		"policy": map[string]any{
			"approverRole": "approver",
			"expiresIn":    "PT15M",
		},
	})
	publishOps(t, h, admin, tenant, ws, "policies", pol.Resource.ID, 1, "v1")

	yamlDoc := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e103-wait-policy
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Approve
      with:
        approverRole: approver
        expiresIn: PT15M
        policyId: ` + pol.Resource.ID + `
  edges: []
`
	wf := createWorkflow(t, h, admin, tenant, ws, yamlDoc)
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "wait")
	exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)
	if exec.Status != wfstore.ExecutionQueued {
		t.Fatalf("start status = %s", exec.Status)
	}

	approver := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e103-approver","role_keys":["approver"]}`)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/approvals/catalog", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("approval catalog: %d %s", rec.Code, rec.Body.String())
	}
	var cat approval.Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil || !cat.WaitResumeEnabled || cat.ResumeRoute == "" {
		t.Fatalf("waitResumeEnabled catalog = %+v %v", cat, err)
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"e103-worker","leaseSeconds":5}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}
	var claimed claimJobResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if claimed.Job.Status != wfstore.JobWaiting || claimed.Step.Status != wfstore.ExecutionWaiting || claimed.Execution.Status != wfstore.ExecutionWaiting {
		t.Fatalf("park = job=%s step=%s exec=%s token=%q", claimed.Job.Status, claimed.Step.Status, claimed.Execution.Status, claimed.JobToken)
	}
	if claimed.JobToken != "" {
		t.Fatalf("waiting jobs must not issue a worker ticket")
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals?executionId="+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list approvals: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[approval.Record]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed.Items) != 1 {
		t.Fatalf("pending wait = %s %v", rec.Body.String(), err)
	}
	pending := listed.Items[0]
	if pending.ExecutionID != exec.ID || pending.Status != approval.StatusPending {
		t.Fatalf("pending = %+v", pending)
	}
	if pending.BindingFingerprint == approval.BindingFingerprint(ws.ID, pub.Version.ID, pub.Version.Digest, pending.TargetVersionID, pending.PolicyVersionID, pending.PolicyDigest, pending.Operation, pending.NodeID) {
		t.Fatalf("mid-run fingerprint must include execution id")
	}

	t.Run("wait survives recover", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/jobs/recover", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("recover: %d %s", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		var still wfstore.Execution
		if err := json.Unmarshal(rec.Body.Bytes(), &still); err != nil {
			t.Fatal(err)
		}
		if still.Status != wfstore.ExecutionWaiting {
			t.Fatalf("after recover status = %s", still.Status)
		}
	})

	t.Run("requester cannot self-approve mid-run", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"decision": "approved"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/approvals/"+pending.ID+"/decide", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("policy change invalidates and expires wait", func(t *testing.T) {
		saved, _ := json.Marshal(map[string]any{
			"revision": 1,
			"spec": map[string]any{
				"kind": "approval",
				"policy": map[string]any{
					"approverRole": "approver",
					"expiresIn":    "PT30M",
				},
			},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/policies/"+pol.Resource.ID+"/draft", saved, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save policy: %d %s", rec.Code, rec.Body.String())
		}
		publishOps(t, h, admin, tenant, ws, "policies", pol.Resource.ID, 2, "v2")

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+pending.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		var recd approval.Record
		if err := json.Unmarshal(rec.Body.Bytes(), &recd); err != nil {
			t.Fatal(err)
		}
		if recd.Status != approval.StatusInvalidated {
			t.Fatalf("status = %s", recd.Status)
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		var done wfstore.Execution
		if err := json.Unmarshal(rec.Body.Bytes(), &done); err != nil {
			t.Fatal(err)
		}
		if done.Status != wfstore.ExecutionSucceeded {
			t.Fatalf("invalidated wait should resume expired/succeeded, got %s", done.Status)
		}
	})

	t.Run("fresh start resume after approve", func(t *testing.T) {
		wf2 := createWorkflow(t, h, admin, tenant, ws, approvalWaitYAMLNamed("e103-wait-approve"))
		pub2 := publishWorkflow(t, h, admin, tenant, ws, wf2.Workflow.ID, wf2.Draft.Revision, "wait2")
		exec2 := startExecution(t, h, admin, tenant, ws, wf2.Workflow.ID, pub2.Version.ID)
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"e103-worker-b","leaseSeconds":5}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("claim2: %d %s", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/approvals?executionId="+exec2.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		var listed listResponse[approval.Record]
		if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed.Items) != 1 {
			t.Fatalf("pending2 = %s %v", rec.Body.String(), err)
		}
		body, _ := json.Marshal(map[string]string{"decision": "approved"})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/approvals/"+listed.Items[0].ID+"/decide", body, approver.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("decide: %d %s", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec2.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		var done wfstore.Execution
		if err := json.Unmarshal(rec.Body.Bytes(), &done); err != nil {
			t.Fatal(err)
		}
		if done.Status != wfstore.ExecutionSucceeded {
			t.Fatalf("approved resume = %s %s", done.Status, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec2.ID+"/steps", nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		var steps listResponse[wfstore.ExecutionStep]
		if err := json.Unmarshal(rec.Body.Bytes(), &steps); err != nil || len(steps.Items) == 0 {
			t.Fatalf("steps = %s %v", rec.Body.String(), err)
		}
		if steps.Items[0].Output["port"] != "approved" {
			t.Fatalf("port = %+v", steps.Items[0].Output)
		}
	})

	t.Run("expiry resumes expired port", func(t *testing.T) {
		wf3 := createWorkflow(t, h, admin, tenant, ws, approvalWaitYAMLNamed("e103-wait-expire"))
		pub3 := publishWorkflow(t, h, admin, tenant, ws, wf3.Workflow.ID, wf3.Draft.Revision, "wait3")
		exec3 := startExecution(t, h, admin, tenant, ws, wf3.Workflow.ID, pub3.Version.ID)
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"e103-worker-c","leaseSeconds":5}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("claim3: %d %s", rec.Code, rec.Body.String())
		}
		frozen.Store(base.Add(20 * time.Minute).UnixNano())
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/jobs/recover", []byte(`{}`), admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("recover expire: %d %s", rec.Code, rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec3.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		var done wfstore.Execution
		if err := json.Unmarshal(rec.Body.Bytes(), &done); err != nil {
			t.Fatal(err)
		}
		if done.Status != wfstore.ExecutionSucceeded {
			t.Fatalf("expired wait = %s", done.Status)
		}
	})
}
