package httpapi

import (
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type createWorkflowRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	DefinitionYAML string `json:"definitionYaml"`
}

type saveDraftRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Revision       int64  `json:"revision"`
	DefinitionYAML string `json:"definitionYaml"`
}

type publishRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Revision       int64  `json:"revision"`
	Note           string `json:"note"`
}

type compareRequest struct {
	ID             string             `json:"id"`
	WorkspaceID    string             `json:"workspace_id"`
	WorkspaceIDAlt string             `json:"workspaceId"`
	Left           wfstore.CompareRef `json:"left"`
	Right          wfstore.CompareRef `json:"right"`
}

type restoreRequest struct {
	ID               string `json:"id"`
	WorkspaceID      string `json:"workspace_id"`
	WorkspaceIDAlt   string `json:"workspaceId"`
	ExpectedRevision int64  `json:"expectedRevision"`
}

type startExecutionRequest struct {
	ID                string `json:"id"`
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceIDAlt    string `json:"workspaceId"`
	WorkflowVersionID string `json:"workflowVersionId"`
	Draft             *bool  `json:"draft"`
	Source            string `json:"source"`
	WorkflowDraftID   string `json:"workflowDraftId"`
}

type workflowDetailResponse struct {
	Workflow wfstore.Workflow `json:"workflow"`
	Draft    wfstore.Draft    `json:"draft"`
}

type publishResponse struct {
	Workflow wfstore.Workflow `json:"workflow"`
	Version  wfstore.Version  `json:"version"`
	Pins     []opsconfig.Pin  `json:"pins"`
}

type executionResponse struct {
	wfstore.Execution
	Pins []opsconfig.Pin `json:"pins"`
}

type exportResponse struct {
	WorkflowID     string `json:"workflowId"`
	VersionID      string `json:"versionId"`
	VersionNumber  int    `json:"versionNumber"`
	Digest         string `json:"digest"`
	Filename       string `json:"filename"`
	DefinitionYAML string `json:"definitionYaml"`
}

func (s *Server) requireWorkflowStore(w http.ResponseWriter, r *http.Request) bool {
	if s.workflows != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
	return false
}

func (s *Server) listWorkflows(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	items, err := s.workflows.List(r.Context(), scope)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.Workflow]{Items: items})
}

func (s *Server) createWorkflow(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	var req createWorkflowRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if strings.TrimSpace(req.DefinitionYAML) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "definitionYaml is required.")
		return
	}
	res, errs := workflow.ParseAndNormalize([]byte(req.DefinitionYAML))
	if len(errs) > 0 {
		writeWorkflowErrors(w, r, errs)
		return
	}
	wf, draft, err := s.workflows.Create(r.Context(), scope, wfstore.CreateInput{
		Slug:           strings.TrimSpace(req.Slug),
		Name:           strings.TrimSpace(req.Name),
		NormalizedYAML: res.NormalizedYAML,
		Digest:         res.Digest,
		Summary:        res.Summary,
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, workflowDetailResponse{Workflow: wf, Draft: draft})
}

func reservedWorkflowCollection(id string) bool {
	switch id {
	case "catalog", "validate", "normalize":
		return true
	default:
		return false
	}
}

func (s *Server) rejectReservedWorkflowPath(w http.ResponseWriter, r *http.Request) bool {
	if !reservedWorkflowCollection(strings.TrimSpace(r.PathValue("workflowId"))) {
		return false
	}
	switch r.URL.Path {
	case "/api/v1/workflows/catalog":
		w.Header().Set("Allow", "GET, HEAD")
	case "/api/v1/workflows/validate", "/api/v1/workflows/normalize":
		w.Header().Set("Allow", "POST")
	}
	WriteProblem(w, r, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed", "The "+r.Method+" method is not allowed for this path.")
	return true
}

func (s *Server) getWorkflow(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	id := strings.TrimSpace(r.PathValue("workflowId"))
	wf, err := s.workflows.Get(r.Context(), scope, id)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wf)
}

func (s *Server) getWorkflowDraft(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	draft, err := s.workflows.GetDraft(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, draft)
}

func (s *Server) putWorkflowDraft(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	src, expected, ok := readDraftSave(w, r)
	if !ok {
		return
	}
	res, errs := workflow.ParseAndNormalize(src)
	if len(errs) > 0 {
		writeWorkflowErrors(w, r, errs)
		return
	}
	wf, draft, err := s.workflows.SaveDraft(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), wfstore.SaveInput{
		ExpectedRevision: expected,
		NormalizedYAML:   res.NormalizedYAML,
		Digest:           res.Digest,
		Summary:          res.Summary,
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, workflowDetailResponse{Workflow: wf, Draft: draft})
}

func (s *Server) publishWorkflow(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowPublish)
	if !ok {
		return
	}
	var req publishRequest
	if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	draft, err := s.workflows.GetDraft(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	if refs := opsconfig.ExtractRefs(draft.DefinitionYAML); len(refs) > 0 && s.ops != nil {
		if _, err := s.ops.Resolve(r.Context(), scope, refs); err != nil {
			writeOpsError(w, r, err)
			return
		}
	}
	wf, ver, err := s.workflows.Publish(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), wfstore.PublishInput{
		ExpectedRevision: req.Revision,
		Note:             req.Note,
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	pins, ok := s.pinWorkflowRefs(w, r, scope, ver.DefinitionYAML, opsconfig.OwnerWorkflowVersion, ver.ID)
	if !ok {
		return
	}
	writeJSON(w, http.StatusCreated, publishResponse{Workflow: wf, Version: ver, Pins: pins})
}

func (s *Server) listWorkflowVersions(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	items, err := s.workflows.ListVersions(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.Version]{Items: items})
}

func (s *Server) getWorkflowVersion(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	ver, err := s.workflows.GetVersion(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("versionId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ver)
}

func (s *Server) exportWorkflowVersion(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	ver, err := s.workflows.GetVersion(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("versionId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	filename := ver.Summary.Name + ".v" + strconv.Itoa(ver.VersionNumber) + ".yaml"
	if strings.TrimSpace(ver.Summary.Name) == "" {
		filename = "workflow.v" + strconv.Itoa(ver.VersionNumber) + ".yaml"
	}
	payload := exportResponse{
		WorkflowID:     ver.WorkflowID,
		VersionID:      ver.ID,
		VersionNumber:  ver.VersionNumber,
		Digest:         ver.Digest,
		Filename:       filename,
		DefinitionYAML: ver.DefinitionYAML,
	}
	if wantsYAML(r) {
		w.Header().Set("Content-Type", "application/yaml")
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		w.Header().Set("X-FlowForge-Digest", ver.Digest)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(ver.DefinitionYAML))
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) compareWorkflow(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	var req compareRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if strings.TrimSpace(req.Left.Kind) == "" || strings.TrimSpace(req.Right.Kind) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "left.kind and right.kind are required (draft or version).")
		return
	}
	out, err := s.workflows.Compare(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), req.Left, req.Right)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) restoreWorkflowVersion(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	var req restoreRequest
	if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	wf, draft, err := s.workflows.Restore(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), wfstore.RestoreInput{
		VersionID:        strings.TrimSpace(r.PathValue("versionId")),
		ExpectedRevision: req.ExpectedRevision,
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, workflowDetailResponse{Workflow: wf, Draft: draft})
}

func (s *Server) startWorkflowExecution(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req startExecutionRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if req.Draft != nil && *req.Draft || strings.EqualFold(req.Source, "draft") || strings.TrimSpace(req.WorkflowDraftID) != "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Drafts cannot be executed. Select a published workflow version.")
		return
	}
	if strings.TrimSpace(req.WorkflowVersionID) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Drafts cannot be executed. Select a published workflow version.")
		return
	}
	ver, err := s.workflows.GetVersion(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), req.WorkflowVersionID)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 && s.ops != nil {
		if _, err := s.ops.Resolve(r.Context(), scope, refs); err != nil {
			writeOpsError(w, r, err)
			return
		}
	}
	exec, err := s.workflows.StartExecution(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), wfstore.StartInput{
		VersionID: req.WorkflowVersionID,
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	pins := []opsconfig.Pin{}
	if s.ops != nil {
		copied, copyErr := s.ops.CopyPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID)
		if copyErr != nil {
			writeOpsError(w, r, copyErr)
			return
		}
		if len(copied) == 0 {
			var ok bool
			pins, ok = s.pinWorkflowRefs(w, r, scope, ver.DefinitionYAML, opsconfig.OwnerExecution, exec.ID)
			if !ok {
				return
			}
		} else {
			pins = copied
		}
	}
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	_, _, _, perms, ok := s.requireAccess(w, r, user, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	if !s.authorizeExecutionPins(w, r, perms, pins) {
		return
	}
	writeJSON(w, http.StatusCreated, executionResponse{Execution: exec, Pins: pins})
}

func (s *Server) getWorkflowExecution(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	exec, err := s.workflows.GetExecution(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	pins := []opsconfig.Pin{}
	if s.ops != nil {
		pins, err = s.ops.ListPins(r.Context(), scope, opsconfig.OwnerExecution, exec.ID)
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, executionResponse{Execution: exec, Pins: pins})
}

func (s *Server) workflowScope(w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !s.requireWorkflowStore(w, r) {
		return isolation.Scope{}, false
	}
	return s.requireScope(w, r, user, perm)
}

func readDraftSave(w http.ResponseWriter, r *http.Request) ([]byte, int64, bool) {
	ct := r.Header.Get("Content-Type")
	mediaType := ""
	if ct != "" {
		var err error
		mediaType, _, err = mime.ParseMediaType(ct)
		if err != nil {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json or application/yaml.")
			return nil, 0, false
		}
	}
	switch mediaType {
	case "application/json":
		var req saveDraftRequest
		if !DecodeJSON(w, r, &req) {
			return nil, 0, false
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return nil, 0, false
		}
		if strings.TrimSpace(req.DefinitionYAML) == "" {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "definitionYaml is required.")
			return nil, 0, false
		}
		if req.Revision < 1 {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "revision is required for a conflict-safe draft save.")
			return nil, 0, false
		}
		return []byte(req.DefinitionYAML), req.Revision, true
	case "application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml":
		src, ok := readDefinitionYAML(w, r)
		if !ok {
			return nil, 0, false
		}
		rev, ok := parseRevisionHeader(r.Header.Get("If-Match"))
		if !ok {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "If-Match must be the current draft revision.")
			return nil, 0, false
		}
		return src, rev, true
	default:
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json or application/yaml.")
		return nil, 0, false
	}
}

func parseRevisionHeader(raw string) (int64, bool) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "W/")
	raw = strings.Trim(raw, `"`)
	if raw == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

func hostIdentitySet(values ...string) bool {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return true
		}
	}
	return false
}

func wantsYAML(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	return strings.Contains(accept, "application/yaml") || strings.Contains(accept, "text/yaml")
}

func writeWorkflowStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, wfstore.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, wfstore.ErrRevisionConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Draft revision does not match the current saved revision.")
	case errors.Is(err, wfstore.ErrDuplicateVersion):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "This normalized definition is already published.")
	case errors.Is(err, wfstore.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "A workflow with this slug already exists.")
	case errors.Is(err, wfstore.ErrImmutable):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Published versions are immutable.")
	case errors.Is(err, wfstore.ErrDraftNotRunnable):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Drafts cannot be executed. Select a published workflow version.")
	case errors.Is(err, wfstore.ErrInvalid), errors.Is(err, wfstore.ErrNoScope):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, wfstore.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
