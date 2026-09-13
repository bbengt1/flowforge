package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestWorkflowFoldersHappyPathAndFilters(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	ops := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "Ops"})
	if ops.ParentID != nil || ops.WorkspaceID != ws.ID || ops.Name != "Ops" {
		t.Fatalf("create top-level: %+v", ops)
	}
	oncall := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "On-call", "parentId": ops.ID})
	if oncall.ParentID == nil || *oncall.ParentID != ops.ID {
		t.Fatalf("create child: %+v", oncall)
	}

	listed := listFolders(t, h, admin, tenant, ws)
	if len(listed) != 2 {
		t.Fatalf("list folders = %+v", listed)
	}

	got := getFolder(t, h, admin, tenant, ws, ops.ID)
	if got.Name != "Ops" {
		t.Fatalf("get: %+v", got)
	}

	renamed := patchFolder(t, h, admin, tenant, ws, ops.ID, map[string]any{"name": "Operations"})
	if renamed.Name != "Operations" {
		t.Fatalf("rename: %+v", renamed)
	}

	unfiled := createWorkflow(t, h, admin, tenant, ws, validWorkflowYAML)
	if unfiled.Workflow.FolderID != nil {
		t.Fatalf("create without folderId should be unfiled: %+v", unfiled.Workflow)
	}
	filed := createWorkflowInFolder(t, h, admin, tenant, ws, validWorkflowYAML, oncall.ID, "filed-oncall")
	if filed.Workflow.FolderID == nil || *filed.Workflow.FolderID != oncall.ID {
		t.Fatalf("create with folderId: %+v", filed.Workflow)
	}

	all := listWorkflowsQuery(t, h, admin, tenant, ws, "")
	if len(all) != 2 {
		t.Fatalf("unfiltered list = %d", len(all))
	}
	unfiledItems := listWorkflowsQuery(t, h, admin, tenant, ws, "unfiled")
	if len(unfiledItems) != 1 || unfiledItems[0].ID != unfiled.Workflow.ID || unfiledItems[0].FolderID != nil {
		t.Fatalf("unfiled filter = %+v", unfiledItems)
	}
	filedItems := listWorkflowsQuery(t, h, admin, tenant, ws, oncall.ID)
	if len(filedItems) != 1 || filedItems[0].ID != filed.Workflow.ID {
		t.Fatalf("folderId filter = %+v", filedItems)
	}

	revision := unfiled.Workflow.DraftRevision
	digest := unfiled.Workflow.DraftDigest
	moved := moveWorkflow(t, h, admin, tenant, ws, unfiled.Workflow.ID, ops.ID)
	if moved.FolderID == nil || *moved.FolderID != ops.ID {
		t.Fatalf("move: %+v", moved)
	}
	if moved.DraftRevision != revision || moved.DraftDigest != digest {
		t.Fatalf("move bumped draft: %+v", moved)
	}
	draft := getWorkflowDraft(t, h, admin, tenant, ws, unfiled.Workflow.ID)
	if draft.Revision != revision || draft.Digest != digest {
		t.Fatalf("move changed draft YAML: %+v", draft)
	}

	unfiledAgain := moveWorkflowToUnfiled(t, h, admin, tenant, ws, unfiled.Workflow.ID)
	if unfiledAgain.FolderID != nil || unfiledAgain.DraftRevision != revision {
		t.Fatalf("move to unfiled: %+v", unfiledAgain)
	}

	empty := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "Empty"})
	deleteFolder(t, h, admin, tenant, ws, empty.ID)

	assertFolderAudits(t, h, admin, tenant, ws)
}

func TestWorkflowFoldersSiblingUniquenessDepthAndCycle(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	parent := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "Ops"})
	createFolder(t, h, admin, tenant, ws, map[string]any{"name": "Deploy"})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", folderJSON(map[string]any{"name": "ops"}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")

	createFolder(t, h, admin, tenant, ws, map[string]any{"name": "ops", "parentId": parent.ID})

	l1 := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "L1"})
	l2 := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "L2", "parentId": l1.ID})
	l3 := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "L3", "parentId": l2.ID})
	l4 := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "L4", "parentId": l3.ID})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", folderJSON(map[string]any{"name": "L5", "parentId": l4.ID}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPatch, "/api/v1/workflow-folders/"+l1.ID, folderJSON(map[string]any{"parentId": l4.ID}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", folderJSON(map[string]any{"name": "bad/name"}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
}

func TestWorkflowFoldersRefuseNonEmptyDelete(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	parent := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "Parent"})
	createFolder(t, h, admin, tenant, ws, map[string]any{"name": "Child", "parentId": parent.ID})
	createWorkflowInFolder(t, h, admin, tenant, ws, validWorkflowYAML, parent.ID, "filed-parent")

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodDelete, "/api/v1/workflow-folders/"+parent.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	p := assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")
	var extra struct {
		WorkflowCount    int `json:"workflowCount"`
		ChildFolderCount int `json:"childFolderCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &extra); err != nil {
		t.Fatal(err)
	}
	if extra.WorkflowCount != 1 || extra.ChildFolderCount != 1 {
		t.Fatalf("counts = %+v problem=%+v", extra, p)
	}
	if listWorkflowsQuery(t, h, admin, tenant, ws, "")[0].FolderID == nil {
		t.Fatal("delete cascaded a workflow")
	}
}

func TestWorkflowFoldersRBACAndTenancy(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	folder := createFolder(t, h, admin, tenant, ws, map[string]any{"name": "Ops"})
	wf := createWorkflow(t, h, admin, tenant, ws, validWorkflowYAML)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"folder-viewer","role_keys":["viewer"]}`)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflow-folders", nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer list: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", folderJSON(map[string]any{"name": "Nope"}), viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPatch, "/api/v1/workflow-folders/"+folder.ID, folderJSON(map[string]any{"name": "Renamed"}), viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodDelete, "/api/v1/workflow-folders/"+folder.ID, nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPatch, "/api/v1/workflows/"+wf.Workflow.ID+"/folder", folderJSON(map[string]any{"folderId": folder.ID}), viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", []byte(`{"workspaceId":"`+ws.ID+`","name":"Host"}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", []byte(`{"workspace_id":"`+ws.ID+`","name":"Host"}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", []byte(`{"id":"11111111-1111-4111-8111-111111111111","name":"Host"}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	wsB := createSecondWorkspace(t, h, admin, tenant)
	outsider := putMember(t, h, admin, tenant, wsB, `{"issuer":"https://idp.example","external_subject":"folder-outsider","role_keys":["admin"]}`)
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflow-folders/"+folder.ID, nil, outsider.User, tenant, wsB)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows", folderJSON(map[string]any{
		"definitionYaml": validWorkflowYAML,
		"folderId":       folder.ID,
	}), outsider.User, tenant, wsB)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows?folderId="+folder.ID, nil, outsider.User, tenant, wsB)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")
}

func TestWorkflowFoldersUnknownFolderAndInvalidName(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	missing := "11111111-1111-4111-8111-111111111111"

	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows", folderJSON(map[string]any{
		"definitionYaml": validWorkflowYAML,
		"folderId":       missing,
	}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")

	wf := createWorkflow(t, h, admin, tenant, ws, validWorkflowYAML)
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPatch, "/api/v1/workflows/"+wf.Workflow.ID+"/folder", folderJSON(map[string]any{"folderId": missing}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", folderJSON(map[string]any{"name": strings.Repeat("a", 65)}), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	ok := createFolder(t, h, admin, tenant, ws, map[string]any{"name": strings.Repeat("a", 64)})
	if len(ok.Name) != 64 {
		t.Fatalf("64 graphemes: %+v", ok)
	}
}

func createFolder(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, body map[string]any) wfstore.Folder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflow-folders", folderJSON(body), user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create folder: %d %s", rec.Code, rec.Body.String())
	}
	var out wfstore.Folder
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func patchFolder(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, id string, body map[string]any) wfstore.Folder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPatch, "/api/v1/workflow-folders/"+id, folderJSON(body), user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch folder: %d %s", rec.Code, rec.Body.String())
	}
	var out wfstore.Folder
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func getFolder(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, id string) wfstore.Folder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflow-folders/"+id, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get folder: %d %s", rec.Code, rec.Body.String())
	}
	var out wfstore.Folder
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func listFolders(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace) []wfstore.Folder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflow-folders", nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list folders: %d %s", rec.Code, rec.Body.String())
	}
	var out listResponse[wfstore.Folder]
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Items
}

func deleteFolder(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, id string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodDelete, "/api/v1/workflow-folders/"+id, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete folder: %d %s", rec.Code, rec.Body.String())
	}
}

func createWorkflowInFolder(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, yamlSrc, folderID, slug string) workflowDetailResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows", folderJSON(map[string]any{
		"definitionYaml": yamlSrc,
		"folderId":       folderID,
		"slug":           slug,
	}), user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workflow in folder: %d %s", rec.Code, rec.Body.String())
	}
	var out workflowDetailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func listWorkflowsQuery(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, folderID string) []wfstore.Workflow {
	t.Helper()
	path := "/api/v1/workflows"
	if folderID != "" {
		path += "?folderId=" + folderID
	}
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, path, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list workflows: %d %s", rec.Code, rec.Body.String())
	}
	var out listResponse[wfstore.Workflow]
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Items
}

func moveWorkflow(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, workflowID, folderID string) wfstore.Workflow {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPatch, "/api/v1/workflows/"+workflowID+"/folder", folderJSON(map[string]any{"folderId": folderID}), user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("move workflow: %d %s", rec.Code, rec.Body.String())
	}
	var out wfstore.Workflow
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func moveWorkflowToUnfiled(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, workflowID string) wfstore.Workflow {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPatch, "/api/v1/workflows/"+workflowID+"/folder", []byte(`{"folderId":null}`), user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("move unfiled: %d %s", rec.Code, rec.Body.String())
	}
	var out wfstore.Workflow
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func getWorkflowDraft(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, workflowID string) wfstore.Draft {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflows/"+workflowID+"/draft", nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get draft: %d %s", rec.Code, rec.Body.String())
	}
	var out wfstore.Draft
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func createSecondWorkspace(t *testing.T, h http.Handler, admin identity.User, tenant identity.Tenant) identity.Workspace {
	t.Helper()
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"other-bench","name":"Other"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create second workspace: %d %s", rec.Code, rec.Body.String())
	}
	var ws identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &ws); err != nil {
		t.Fatal(err)
	}
	return ws
}

func assertFolderAudits(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/audit-events?limit=100", nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list audits: %d %s", rec.Code, rec.Body.String())
	}
	var out listResponse[wfstore.AuditEvent]
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	saw := map[string]bool{}
	for _, ev := range out.Items {
		body, _ := json.Marshal(ev)
		if strings.Contains(strings.ToLower(string(body)), "secret") || strings.Contains(string(body), "definitionYaml") {
			t.Fatalf("audit leaked secrets or YAML: %s", body)
		}
		saw[ev.Action] = true
	}
	for _, action := range []string{"workflow_folder.create", "workflow_folder.rename", "workflow_folder.delete", "workflow.folder.move"} {
		if !saw[action] {
			t.Fatalf("missing audit %s in %+v", action, saw)
		}
	}
}

func folderJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
