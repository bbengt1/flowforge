package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

type createFolderRequest struct {
	ID             string  `json:"id"`
	WorkspaceID    string  `json:"workspace_id"`
	WorkspaceIDAlt string  `json:"workspaceId"`
	Name           string  `json:"name"`
	ParentID       *string `json:"parentId"`
}

type updateFolderRequest struct {
	ID             string          `json:"id"`
	WorkspaceID    string          `json:"workspace_id"`
	WorkspaceIDAlt string          `json:"workspaceId"`
	Name           *string         `json:"name"`
	ParentID       json.RawMessage `json:"parentId"`
}

type moveWorkflowFolderRequest struct {
	ID             string  `json:"id"`
	WorkspaceID    string  `json:"workspace_id"`
	WorkspaceIDAlt string  `json:"workspaceId"`
	FolderID       *string `json:"folderId"`
}

type folderNotEmptyProblem struct {
	Type             string `json:"type"`
	Title            string `json:"title"`
	Status           int    `json:"status"`
	Detail           string `json:"detail"`
	Instance         string `json:"instance"`
	Code             string `json:"code"`
	RequestID        string `json:"request_id"`
	WorkflowCount    int    `json:"workflowCount"`
	ChildFolderCount int    `json:"childFolderCount"`
}

func (s *Server) listWorkflowFolders(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	q, ok := parsePage(w, r)
	if !ok {
		return
	}
	items, next, err := s.workflows.ListFoldersPage(r.Context(), scope, q)
	if rejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	writePage(w, items, q, next)
}

func (s *Server) createWorkflowFolder(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	var req createFolderRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	parentID := ""
	if req.ParentID != nil {
		parentID = strings.TrimSpace(*req.ParentID)
	}
	folder, err := s.workflows.CreateFolder(r.Context(), scope, wfstore.CreateFolderInput{
		Name:     req.Name,
		ParentID: parentID,
	})
	if err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	s.writeFolderAudit(r, scope, "workflow_folder.create", folder.ID, "created", map[string]any{
		"folderId": folder.ID,
		"name":     folder.Name,
		"parentId": folder.ParentID,
	})
	writeJSON(w, http.StatusCreated, folder)
}

func (s *Server) getWorkflowFolder(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	folder, err := s.workflows.GetFolder(r.Context(), scope, strings.TrimSpace(r.PathValue("folderId")))
	if err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

func (s *Server) updateWorkflowFolder(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	var req updateFolderRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	id := strings.TrimSpace(r.PathValue("folderId"))
	before, err := s.workflows.GetFolder(r.Context(), scope, id)
	if err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	in := wfstore.UpdateFolderInput{Name: req.Name}
	if req.ParentID != nil {
		parent, err := decodeOptionalNullableID(req.ParentID)
		if err != nil {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "parentId must be a UUID or null.")
			return
		}
		in.ParentID = parent
	}
	folder, err := s.workflows.UpdateFolder(r.Context(), scope, id, in)
	if err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	if req.Name != nil && folder.Name != before.Name {
		s.writeFolderAudit(r, scope, "workflow_folder.rename", folder.ID, "updated", map[string]any{
			"folderId": folder.ID,
			"fromName": before.Name,
			"toName":   folder.Name,
		})
	}
	if in.ParentID != nil && !sameOptionalID(before.ParentID, folder.ParentID) {
		s.writeFolderAudit(r, scope, "workflow_folder.rename", folder.ID, "updated", map[string]any{
			"folderId":     folder.ID,
			"fromParentId": before.ParentID,
			"toParentId":   folder.ParentID,
		})
	}
	writeJSON(w, http.StatusOK, folder)
}

func (s *Server) deleteWorkflowFolder(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	id := strings.TrimSpace(r.PathValue("folderId"))
	folder, err := s.workflows.GetFolder(r.Context(), scope, id)
	if err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	if err := s.workflows.DeleteFolder(r.Context(), scope, id); err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	s.writeFolderAudit(r, scope, "workflow_folder.delete", folder.ID, "deleted", map[string]any{
		"folderId": folder.ID,
		"name":     folder.Name,
		"parentId": folder.ParentID,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) patchWorkflowFolder(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	var req moveWorkflowFolderRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	workflowID := strings.TrimSpace(r.PathValue("workflowId"))
	before, err := s.workflows.Get(r.Context(), scope, workflowID)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	target := ""
	if req.FolderID != nil {
		target = strings.TrimSpace(*req.FolderID)
	}
	wf, err := s.workflows.SetWorkflowFolder(r.Context(), scope, workflowID, target)
	if err != nil {
		writeFolderStoreError(w, r, err)
		return
	}
	s.writeFolderAudit(r, scope, "workflow.folder.move", wf.ID, "updated", map[string]any{
		"workflowId":   wf.ID,
		"fromFolderId": before.FolderID,
		"toFolderId":   wf.FolderID,
	})
	writeJSON(w, http.StatusOK, wf)
}

func (s *Server) writeFolderAudit(r *http.Request, scope isolation.Scope, action, resourceID, outcome string, details map[string]any) {
	if s.workflows == nil {
		return
	}
	if details == nil {
		details = map[string]any{}
	}
	resourceType := "workflow_folder"
	if action == "workflow.folder.move" {
		resourceType = "workflow"
	}
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        action,
		ResourceType:  resourceType,
		ResourceID:    resourceID,
		Outcome:       outcome,
		CorrelationID: RequestIDFromContext(r.Context()),
		HostContext:   map[string]any{"requestId": RequestIDFromContext(r.Context())},
		Details:       details,
	})
}

func writeFolderStoreError(w http.ResponseWriter, r *http.Request, err error) {
	var notEmpty wfstore.FolderNotEmptyError
	switch {
	case errors.As(err, &notEmpty):
		writeFolderNotEmpty(w, r, notEmpty)
	case errors.Is(err, wfstore.ErrFolderCycle):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Re-parenting this folder would create a cycle.")
	case errors.Is(err, wfstore.ErrFolderDepth):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Folders cannot be nested more than 4 levels.")
	case errors.Is(err, wfstore.ErrFolderName):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Folder name must be 1-64 graphemes with no '/' or control characters.")
	case errors.Is(err, wfstore.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "A folder with this name already exists among siblings.")
	case errors.Is(err, wfstore.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	default:
		writeWorkflowStoreError(w, r, err)
	}
}

func writeFolderNotEmpty(w http.ResponseWriter, r *http.Request, err wfstore.FolderNotEmptyError) {
	p := folderNotEmptyProblem{
		Type:             problemTypePrefix + CodeConflict,
		Title:            "Conflict",
		Status:           http.StatusConflict,
		Detail:           "Move or delete contents first.",
		Instance:         r.URL.Path,
		Code:             CodeConflict,
		RequestID:        RequestIDFromContext(r.Context()),
		WorkflowCount:    err.WorkflowCount,
		ChildFolderCount: err.ChildFolderCount,
	}
	body, encErr := json.Marshal(p)
	if encErr != nil {
		http.Error(w, "failed to encode problem details", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusConflict)
	_, _ = w.Write(body)
}

func decodeOptionalNullableID(raw json.RawMessage) (*string, error) {
	if string(raw) == "null" {
		empty := ""
		return &empty, nil
	}
	var id string
	if err := json.Unmarshal(raw, &id); err != nil {
		return nil, err
	}
	id = strings.TrimSpace(id)
	return &id, nil
}

func sameOptionalID(a, b *string) bool {
	as := ""
	bs := ""
	if a != nil {
		as = strings.TrimSpace(*a)
	}
	if b != nil {
		bs = strings.TrimSpace(*b)
	}
	return as == bs
}
