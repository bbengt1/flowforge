package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestPolicyEvaluateAndApprovalBoundary(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	cred := createKubernetesCredential(t, h, admin, tenant, ws, "Cluster")

	pol := createOpsResource(t, h, admin, tenant, ws, "policies", "k8s-gate", map[string]any{
		"kind": "kubernetes",
		"policy": map[string]any{
			"allowedNamespaces": []string{"cp-ops-nprd"},
			"requireApproval":   true,
			"approverRole":      "approver",
			"expiresIn":         "PT1H",
		},
	})
	pubPol := publishOps(t, h, admin, tenant, ws, "policies", pol.Resource.ID, 1, "v1")
	target := createOpsResource(t, h, admin, tenant, ws, "cluster-targets", "prod-cluster", clusterSpecWithPolicy(cred.ID, pol.Resource.ID))
	pubTarget := publishOps(t, h, admin, tenant, ws, "cluster-targets", target.Resource.ID, 1, "initial")
	_ = pubPol
	_ = pubTarget

	wf := createWorkflow(t, h, admin, tenant, ws, workflowYAMLWithTarget(target.Resource.ID))
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "run")

	t.Run("evaluate returns bound requirement", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"workflowId": wf.Workflow.ID, "workflowVersionId": pub.Version.ID})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/policy/evaluate", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("evaluate: %d %s", rec.Code, rec.Body.String())
		}
		var out evaluateResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out.Decision != policy.DecisionApprovalRequired || out.DispatchAllowed || len(out.Requirements) != 1 {
			t.Fatalf("evaluate = %+v", out)
		}
		reqn := out.Requirements[0]
		if reqn.TargetID != target.Resource.ID {
			t.Fatalf("requirement = %+v", reqn)
		}
		if reqn.TargetVersionID != pubTarget.Version.ID || reqn.PolicyVersionID != pubPol.Version.ID || reqn.PolicyRevision != 1 {
			t.Fatalf("binding = %+v", reqn)
		}
	})

	t.Run("dispatch without approval is 409 and materializes a pending row", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"workflowVersionId": pub.Version.ID})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusConflict, CodeConflict, "")

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/approvals?workflowVersionId="+pub.Version.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
		}
		var listed listResponse[approval.Record]
		if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
			t.Fatal(err)
		}
		if len(listed.Items) != 1 || listed.Items[0].Status != approval.StatusPending {
			t.Fatalf("pending = %+v", listed.Items)
		}
	})

	approver := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e43-approver","role_keys":["approver"]}`)
	operator := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e43-operator","role_keys":["operator"]}`)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e43-viewer","role_keys":["viewer"]}`)

	var pending approval.Record
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/approvals?status=pending", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	var listed listResponse[approval.Record]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || len(listed.Items) == 0 {
		t.Fatalf("pending list: %s %v", rec.Body.String(), err)
	}
	pending = listed.Items[0]

	t.Run("requester cannot self-approve", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"decision": "approved"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/approvals/"+pending.ID+"/decide", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("operator cannot decide", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"decision": "approved"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/approvals/"+pending.ID+"/decide", body, operator.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("viewer cannot decide", func(t *testing.T) {
		if contains(viewer.Permissions, authz.PermApprovalDecide) {
			t.Fatal("viewer must not decide")
		}
		body, _ := json.Marshal(map[string]string{"decision": "approved"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/approvals/"+pending.ID+"/decide", body, viewer.User, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("approver decide then dispatch", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"decision": "approved"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/approvals/"+pending.ID+"/decide", body, approver.User, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("decide: %d %s", rec.Code, rec.Body.String())
		}
		var decided approval.Record
		if err := json.Unmarshal(rec.Body.Bytes(), &decided); err != nil {
			t.Fatal(err)
		}
		if decided.Status != approval.StatusApproved || decided.DecidedBy == decided.RequestedBy {
			t.Fatalf("decided = %+v", decided)
		}
		exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)
		if exec.WorkflowVersionID != pub.Version.ID {
			t.Fatalf("exec = %+v", exec)
		}
	})

	t.Run("changed policy invalidates prior approval", func(t *testing.T) {
		saved, _ := json.Marshal(map[string]any{
			"revision": 1,
			"spec": map[string]any{
				"kind": "kubernetes",
				"policy": map[string]any{
					"allowedNamespaces": []string{"cp-ops-nprd"},
					"requireApproval":   true,
					"approverRole":      "approver",
					"expiresIn":         "PT2H",
				},
			},
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/policies/"+pol.Resource.ID+"/draft", saved, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save policy: %d %s", rec.Code, rec.Body.String())
		}
		next := publishOps(t, h, admin, tenant, ws, "policies", pol.Resource.ID, 2, "v2")
		if next.Version.VersionNumber != 2 {
			t.Fatalf("policy v2 = %+v", next)
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+pending.ID, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("get approval: %d %s", rec.Code, rec.Body.String())
		}
		var got approval.Record
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Status != approval.StatusInvalidated {
			t.Fatalf("expected invalidated, got %+v", got)
		}

		body, _ := json.Marshal(map[string]string{"workflowVersionId": pub.Version.ID})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
	})

	t.Run("changed workflow version does not reuse prior approval", func(t *testing.T) {
		draft, _ := json.Marshal(map[string]any{
			"revision":       1,
			"definitionYaml": strings.Replace(workflowYAMLWithTarget(target.Resource.ID), "Restart API", "Restart API v2", 1),
		})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/workflows/"+wf.Workflow.ID+"/draft", draft, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save wf: %d %s", rec.Code, rec.Body.String())
		}
		var saved workflowDetailResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
			t.Fatal(err)
		}
		v2 := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, saved.Draft.Revision, "v2")
		body, _ := json.Marshal(map[string]string{"workflowVersionId": v2.Version.ID})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
	})

	t.Run("deny policy blocks dispatch", func(t *testing.T) {
		deny := createOpsResource(t, h, admin, tenant, ws, "policies", "k8s-deny", map[string]any{
			"kind":   "kubernetes",
			"policy": map[string]any{"allowedNamespaces": []string{"prod-only"}},
		})
		publishOps(t, h, admin, tenant, ws, "policies", deny.Resource.ID, 1, "deny")
		blockedTarget := createOpsResource(t, h, admin, tenant, ws, "cluster-targets", "blocked", clusterSpecWithPolicy(cred.ID, deny.Resource.ID))
		publishOps(t, h, admin, tenant, ws, "cluster-targets", blockedTarget.Resource.ID, 1, "blocked")
		blockedYAML := strings.Replace(workflowYAMLWithTarget(blockedTarget.Resource.ID), "name: restart-api-rollout", "name: blocked-rollout", 1)
		blockedWF := createWorkflow(t, h, admin, tenant, ws, blockedYAML)
		blockedPub := publishWorkflow(t, h, admin, tenant, ws, blockedWF.Workflow.ID, blockedWF.Draft.Revision, "deny")
		body, _ := json.Marshal(map[string]string{"workflowVersionId": blockedPub.Version.ID})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+blockedWF.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("cross-workspace and host identity", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"appr-b","name":"B"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("workspace B: %d %s", rec.Code, rec.Body.String())
		}
		var wsB identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
			t.Fatal(err)
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/approvals/"+pending.ID, nil, admin, tenant, wsB)
		req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

		body := `{"workflowId":"` + wf.Workflow.ID + `","workflowVersionId":"` + pub.Version.ID + `","workspaceId":"33333333-3333-4333-8333-333333333333"}`
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodPost, "/api/v1/policy/evaluate", strings.NewReader(body), admin, tenant, ws)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})
}

func TestApprovalExpiryRecheckedServerSide(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	clock := now
	h, admin := seededWorkspaceWithClock(t, func() time.Time { return clock })
	ws, tenant := currentWorkspace(t, h, admin)

	yamlDoc := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: expire-gate
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
	wf := createWorkflow(t, h, admin, tenant, ws, yamlDoc)
	pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "gate")
	body, _ := json.Marshal(map[string]string{"workflowId": wf.Workflow.ID, "workflowVersionId": pub.Version.ID})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/approvals", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create approvals: %d %s", rec.Code, rec.Body.String())
	}
	var created listResponse[approval.Record]
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || len(created.Items) != 1 {
		t.Fatalf("created = %s %v", rec.Body.String(), err)
	}
	approver := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"e43-exp-approver","role_keys":["approver"]}`)
	clock = now.Add(20 * time.Minute)
	dec, _ := json.Marshal(map[string]string{"decision": "approved"})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/approvals/"+created.Items[0].ID+"/decide", dec, approver.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
}

func TestApprovalCatalogRequiresView(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/approvals/catalog", nil))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func clusterSpecWithPolicy(credentialID, policyID string) map[string]any {
	spec := clusterSpec(credentialID, "https://kube.example")
	spec["policyId"] = policyID
	return spec
}

func seededWorkspaceWithClock(t *testing.T, now func() time.Time) (http.Handler, identity.User) {
	t.Helper()
	store := identity.NewMemory()
	keys := vault.TestKeys()
	workflows := wfstore.NewMemory()
	ops := opsconfig.NewMemory()
	hooks := webhook.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:     store,
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: workflows,
		Ops:       ops,
		Hooks:     hooks,
		Vault:     vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:      keys,
		Approvals: approval.NewMemory(),
		Now:       now,
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
	return h, current.Principal
}
