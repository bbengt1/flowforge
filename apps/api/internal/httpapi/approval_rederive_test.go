package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const rederiveAdminYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: rederive-admin-gate
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
        expiresIn: PT1H
  edges: []
`

func TestDecideRederivesStaleApproverRole(t *testing.T) {
	h, admin, approvals := approvalRederiveServer(t)
	ws, tenant := currentWorkspace(t, h, admin)
	approver := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"rederive-approver","role_keys":["approver"]}`)
	wf := createWorkflow(t, h, admin, tenant, ws, rederiveAdminYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "v1")
	exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)

	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"rederive-worker","leaseSeconds":30}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}

	scope, err := isolation.Authorize(ws.ID, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	stale, err := approvals.Create(context.Background(), scope, approval.CreateInput{
		WorkflowID:        exec.WorkflowID,
		WorkflowVersionID: exec.WorkflowVersionID,
		WorkflowDigest:    exec.WorkflowDigest,
		ExecutionID:       exec.ID,
		RequestedBy:       "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if stale.ApproverRole != "approver" || stale.TargetID != "" || stale.PolicyResourceID != "" || stale.Status != approval.StatusPending {
		t.Fatalf("seed = %+v", stale)
	}

	body, _ := json.Marshal(map[string]string{"decision": "approved"})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/approvals/"+stale.ID+"/decide", body, approver.User, tenant, ws)
	h.ServeHTTP(rec, req)
	problem := assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if problem.Detail != "You are not authorized to perform this action." {
		t.Fatalf("detail = %q", problem.Detail)
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+stale.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	var denied approval.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &denied); err != nil {
		t.Fatal(err)
	}
	if denied.Status != approval.StatusPending || denied.DecidedBy != "" || denied.ApproverRole != "admin" {
		t.Fatalf("after deny = %+v", denied)
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	var waiting wfstore.Execution
	if err := json.Unmarshal(rec.Body.Bytes(), &waiting); err != nil {
		t.Fatal(err)
	}
	if waiting.Status != wfstore.ExecutionWaiting {
		t.Fatalf("run = %s", waiting.Status)
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/approvals/"+stale.ID+"/decide", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin decide: %d %s", rec.Code, rec.Body.String())
	}
	var decided approval.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &decided); err != nil {
		t.Fatal(err)
	}
	if decided.Status != approval.StatusApproved || decided.ApproverRole != "admin" || decided.DecidedBy == "" {
		t.Fatalf("admin decide = %+v", decided)
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	var done wfstore.Execution
	if err := json.Unmarshal(rec.Body.Bytes(), &done); err != nil {
		t.Fatal(err)
	}
	if done.Status != wfstore.ExecutionSucceeded {
		t.Fatalf("approved run = %s", done.Status)
	}
}

func TestDecideTransientRequirementUnavailable(t *testing.T) {
	versions := &transientVersions{Store: wfstore.NewMemory()}
	h, admin, approvals := approvalRederiveServerWith(t, versions)
	ws, tenant := currentWorkspace(t, h, admin)
	wf := createWorkflow(t, h, admin, tenant, ws, rederiveAdminYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "v1")
	scope, err := isolation.Authorize(ws.ID, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := approvals.Create(context.Background(), scope, approval.CreateInput{
		WorkflowID:        wf.Workflow.ID,
		WorkflowVersionID: pub.Version.ID,
		WorkflowDigest:    pub.Version.Digest,
		RequestedBy:       "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	versions.fail.Store(true)
	body, _ := json.Marshal(map[string]string{"decision": "approved"})
	httpRec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/approvals/"+rec.ID+"/decide", body, admin, tenant, ws)
	h.ServeHTTP(httpRec, req)
	if httpRec.Header().Get("Retry-After") != "5" {
		t.Fatalf("Retry-After = %q body=%s", httpRec.Header().Get("Retry-After"), httpRec.Body.String())
	}
	assertProblem(t, httpRec, http.StatusServiceUnavailable, CodeApprovalRequirementUnavailable, "")
	var raw map[string]any
	if err := json.Unmarshal(httpRec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["errors"]; ok {
		t.Fatalf("errors field present: %s", httpRec.Body.String())
	}
	httpRec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+rec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(httpRec, req)
	if httpRec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", httpRec.Code, httpRec.Body.String())
	}
	var still approval.Record
	if err := json.Unmarshal(httpRec.Body.Bytes(), &still); err != nil {
		t.Fatal(err)
	}
	if still.Status != approval.StatusPending || still.DecidedBy != "" || still.ApproverRole != rec.ApproverRole || still.BindingFingerprint != rec.BindingFingerprint || still.CloseReason != "" {
		t.Fatalf("lookup row = %+v", still)
	}
	httpRec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+rec.ID+"/events", nil, admin, tenant, ws)
	h.ServeHTTP(httpRec, req)
	if httpRec.Code != http.StatusOK {
		t.Fatalf("events: %d %s", httpRec.Code, httpRec.Body.String())
	}
	var events struct {
		Items []approval.Event `json:"items"`
	}
	if err := json.Unmarshal(httpRec.Body.Bytes(), &events); err != nil {
		t.Fatal(err)
	}
	for _, ev := range events.Items {
		if ev.EventType == approval.EventCorrected || ev.EventType == approval.EventApproved || ev.EventType == approval.EventCanceled {
			t.Fatalf("event = %+v", ev)
		}
	}
}

func TestDecideDeniesWhenVersionLookupFails(t *testing.T) {
	h, admin, approvals := approvalRederiveServer(t)
	ws, tenant := currentWorkspace(t, h, admin)
	wf := createWorkflow(t, h, admin, tenant, ws, `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: rederive-missing-version
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
        expiresIn: PT1H
  edges: []
`)
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "v1")
	scope, err := isolation.Authorize(ws.ID, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := approvals.Create(context.Background(), scope, approval.CreateInput{
		WorkflowID:        wf.Workflow.ID,
		WorkflowVersionID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		WorkflowDigest:    pub.Version.Digest,
		RequestedBy:       "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"decision": "approved"})
	httpRec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/approvals/"+rec.ID+"/decide", body, admin, tenant, ws)
	h.ServeHTTP(httpRec, req)
	assertProblem(t, httpRec, http.StatusForbidden, CodeForbidden, "")
	httpRec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+rec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(httpRec, req)
	if httpRec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", httpRec.Code, httpRec.Body.String())
	}
	var still approval.Record
	if err := json.Unmarshal(httpRec.Body.Bytes(), &still); err != nil {
		t.Fatal(err)
	}
	if still.Status != approval.StatusPending || still.DecidedBy != "" {
		t.Fatalf("lookup row = %+v", still)
	}
}

type transientVersions struct {
	wfstore.Store
	fail atomic.Bool
}

func (v *transientVersions) GetVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (wfstore.Version, error) {
	if v.fail.Load() {
		return wfstore.Version{}, context.DeadlineExceeded
	}
	return v.Store.GetVersion(ctx, scope, workflowID, versionID)
}

func approvalRederiveServer(t *testing.T) (http.Handler, identity.User, *approval.Memory) {
	t.Helper()
	return approvalRederiveServerWith(t, wfstore.NewMemory())
}

func approvalRederiveServerWith(t *testing.T, workflows wfstore.Store) (http.Handler, identity.User, *approval.Memory) {
	t.Helper()
	approvals := approval.NewMemory()
	idStore := identity.NewMemory()
	keys := vault.TestKeys()
	ops := opsconfig.NewMemory()
	hooks := webhook.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:     idStore,
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: workflows,
		Ops:       ops,
		Hooks:     hooks,
		Vault:     vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:      keys,
		Approvals: approvals,
	}))
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set(headerDisplayName, admin.DisplayName)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("current workspace: %d %s", rec.Code, rec.Body.String())
	}
	var current currentWorkspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	return h, current.Principal, approvals
}

func TestResyncHidesCorrectedRowsFromPlainApprover(t *testing.T) {
	h, admin, approvals := approvalRederiveServer(t)
	ws, tenant := currentWorkspace(t, h, admin)
	approver := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"rederive-list","role_keys":["approver"]}`)
	wf := createWorkflow(t, h, admin, tenant, ws, rederiveAdminYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "v1")
	exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"rederive-list-worker","leaseSeconds":30}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}
	scope, err := isolation.Authorize(ws.ID, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	stale, err := approvals.Create(context.Background(), scope, approval.CreateInput{
		WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
		ExecutionID: exec.ID, RequestedBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	broken, err := approvals.Create(context.Background(), scope, approval.CreateInput{
		WorkflowID: exec.WorkflowID, WorkflowVersionID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", WorkflowDigest: exec.WorkflowDigest,
		RequestedBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	stats := approvals.ResyncPending(context.Background(), rederiveVersions{ver: wfstore.Version{
		ID: exec.WorkflowVersionID, DefinitionYAML: rederiveAdminYAML, Digest: exec.WorkflowDigest,
	}}, nil, time.Now().UTC())
	if stats.Corrected != 1 || stats.Closed != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	again := approvals.ResyncPending(context.Background(), rederiveVersions{ver: wfstore.Version{
		ID: exec.WorkflowVersionID, DefinitionYAML: rederiveAdminYAML, Digest: exec.WorkflowDigest,
	}}, nil, time.Now().UTC())
	if again.Corrected != 0 || again.Closed != 0 {
		t.Fatalf("second = %+v", again)
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals?status=pending&executionId="+exec.ID, nil, approver.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("approver list: %d %s", rec.Code, rec.Body.String())
	}
	var hidden listResponse[approval.Record]
	if err := json.Unmarshal(rec.Body.Bytes(), &hidden); err != nil || len(hidden.Items) != 0 {
		t.Fatalf("approver pending = %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/approvals?status=pending&executionId="+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	var visible listResponse[approval.Record]
	if err := json.Unmarshal(rec.Body.Bytes(), &visible); err != nil || len(visible.Items) != 1 || visible.Items[0].ID != stale.ID || visible.Items[0].ApproverRole != "admin" {
		t.Fatalf("admin pending = %s", rec.Body.String())
	}
	got, err := approvals.Get(context.Background(), scope, broken.ID)
	if err != nil || got.Status != approval.StatusCanceled || got.CloseReason != approval.ReasonRequirementUnresolvable {
		t.Fatalf("closed = %+v %v", got, err)
	}
}

type rederiveVersions struct {
	ver wfstore.Version
}

func (r rederiveVersions) GetVersion(_ context.Context, _ isolation.Scope, _, versionID string) (wfstore.Version, error) {
	if versionID != r.ver.ID {
		return wfstore.Version{}, wfstore.ErrNotFound
	}
	return r.ver, nil
}
