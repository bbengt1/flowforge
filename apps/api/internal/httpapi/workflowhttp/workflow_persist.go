package workflowhttp

import (
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	k8sengine "github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type createWorkflowRequest struct {
	ID             string  `json:"id"`
	WorkspaceID    string  `json:"workspace_id"`
	WorkspaceIDAlt string  `json:"workspaceId"`
	Slug           string  `json:"slug"`
	Name           string  `json:"name"`
	DefinitionYAML string  `json:"definitionYaml"`
	FolderID       *string `json:"folderId"`
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
	ID                string         `json:"id"`
	WorkspaceID       string         `json:"workspace_id"`
	WorkspaceIDAlt    string         `json:"workspaceId"`
	WorkflowVersionID string         `json:"workflowVersionId"`
	Draft             *bool          `json:"draft"`
	Source            string         `json:"source"`
	WorkflowDraftID   string         `json:"workflowDraftId"`
	IdempotencyKey    string         `json:"idempotencyKey"`
	Input             map[string]any `json:"input"`
	CorrelationID     string         `json:"correlationId"`
	TriggerID         string         `json:"triggerId"`
}

type WorkflowDetailResponse struct {
	Workflow WorkflowView  `json:"workflow"`
	Draft    wfstore.Draft `json:"draft"`
}

type PublishResponse struct {
	Workflow        WorkflowView         `json:"workflow"`
	Version         wfstore.Version      `json:"version"`
	Pins            []opsconfig.Pin      `json:"pins"`
	ScriptArtifacts []scripts.VersionPin `json:"scriptArtifacts"`
}

type ExecutionResponse struct {
	wfstore.Execution
	StatusReason string                  `json:"statusReason,omitempty"`
	Pins         []opsconfig.Pin         `json:"pins"`
	Steps        []wfstore.ExecutionStep `json:"steps"`
	Jobs         []wfstore.ExecutionJob  `json:"jobs"`
	AuditEvents  []wfstore.AuditEvent    `json:"auditEvents"`
	Artifacts    []wfstore.Artifact      `json:"artifacts"`
}

type ExportResponse struct {
	WorkflowID     string `json:"workflowId"`
	VersionID      string `json:"versionId"`
	VersionNumber  int    `json:"versionNumber"`
	Digest         string `json:"digest"`
	Filename       string `json:"filename"`
	DefinitionYAML string `json:"definitionYaml"`
}

func requireWorkflowStore(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.Workflows != nil {
		return true
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
	return false
}

func listWorkflows(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, perms, ok := WorkflowScopeGrants(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	q, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	filter, ok := parseWorkflowListFolderQuery(w, r)
	if !ok {
		return
	}
	var next string
	q.Next = &next
	filter.Page = q
	if filter.FolderID != "" {
		if _, err := s.Workflows.GetFolder(r.Context(), scope, filter.FolderID); err != nil {
			writeFolderStoreError(w, r, err)
			return
		}
	}
	items, err := s.Workflows.List(r.Context(), scope, filter)
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WritePage(w, presentWorkflows(perms, scope.ActorID(), items, requestEmbedBound(r)), q, next)
}

func parseWorkflowListFolderQuery(w http.ResponseWriter, r *http.Request) (wfstore.WorkflowListFilter, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("folderId"))
	if raw == "" {
		return wfstore.WorkflowListFilter{}, true
	}
	if strings.EqualFold(raw, wfstore.FolderListUnfiled) {
		return wfstore.WorkflowListFilter{Unfiled: true}, true
	}
	if !authz.ValidUUID(raw) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "folderId must be a UUID or unfiled.")
		return wfstore.WorkflowListFilter{}, false
	}
	return wfstore.WorkflowListFilter{FolderID: raw}, true
}

func CreateWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, perms, ok := WorkflowScopeGrants(s, w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	var req createWorkflowRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if strings.TrimSpace(req.DefinitionYAML) == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "definitionYaml is required.")
		return
	}
	res, errs := workflow.ParseAndNormalize([]byte(req.DefinitionYAML))
	if len(errs) > 0 {
		writeWorkflowErrors(w, r, errs)
		return
	}
	nameOverride := strings.TrimSpace(req.Name)
	if nameOverride != "" && !workflow.ValidDisplayName(nameOverride) {
		writeWorkflowErrors(w, r, workflow.ErrorList{workflow.InvalidDisplayName("name")})
		return
	}
	deriveFrom := nameOverride
	if deriveFrom == "" {
		deriveFrom = res.Summary.Name
	}
	yamlSlug := ""
	if res.Document != nil {
		yamlSlug = res.Document.Metadata.Slug
	}
	// Precedence: JSON slug, then metadata.slug, then a slug derived from name.
	choice, err := wfstore.ChooseCreateSlug(strings.TrimSpace(req.Slug), yamlSlug, deriveFrom)
	if err != nil {
		writeSlugInvalid(w, r)
		return
	}
	folderID := ""
	if req.FolderID != nil {
		folderID = strings.TrimSpace(*req.FolderID)
	}
	wf, draft, err := s.Workflows.Create(r.Context(), scope, wfstore.CreateInput{
		Slug:           choice.Slug,
		SlugDerived:    choice.Derived,
		Name:           nameOverride,
		NormalizedYAML: res.NormalizedYAML,
		Digest:         res.Digest,
		Summary:        res.Summary,
		FolderID:       folderID,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, WorkflowDetailResponse{Workflow: presentWorkflow(perms, scope.ActorID(), wf, requestEmbedBound(r)), Draft: draft})
}

func reservedWorkflowCollection(id string) bool {
	switch id {
	case "catalog", "validate", "normalize":
		return true
	default:
		return false
	}
}

func RejectReservedWorkflowPath(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if !reservedWorkflowCollection(strings.TrimSpace(r.PathValue("workflowId"))) {
		return false
	}
	switch r.URL.Path {
	case "/api/v1/workflows/catalog":
		w.Header().Set("Allow", "GET, HEAD")
	case "/api/v1/workflows/validate", "/api/v1/workflows/normalize":
		w.Header().Set("Allow", "POST")
	}
	core.WriteProblem(w, r, http.StatusMethodNotAllowed, core.CodeMethodNotAllowed, "Method Not Allowed", "The "+r.Method+" method is not allowed for this path.")
	return true
}

func getWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, perms, ok := WorkflowScopeGrants(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	id := strings.TrimSpace(r.PathValue("workflowId"))
	wf, err := s.Workflows.Get(r.Context(), scope, id)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	view := presentWorkflow(perms, scope.ActorID(), wf, requestEmbedBound(r))
	if view.Capabilities.Delete {
		impact, err := s.Workflows.DeleteImpact(r.Context(), scope, wf.ID)
		if err != nil {
			WriteWorkflowStoreError(w, r, err)
			return
		}
		view.DeleteImpact = &impact
	}
	core.WriteJSON(w, http.StatusOK, view)
}

func getWorkflowDraft(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	draft, err := s.Workflows.GetDraft(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, draft)
}

func putWorkflowDraft(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, perms, ok := WorkflowScopeGrants(s, w, r, authz.PermWorkflowEdit)
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
	wf, draft, err := s.Workflows.SaveDraft(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), wfstore.SaveInput{
		ExpectedRevision: expected,
		NormalizedYAML:   res.NormalizedYAML,
		Digest:           res.Digest,
		Summary:          res.Summary,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, WorkflowDetailResponse{Workflow: presentWorkflow(perms, scope.ActorID(), wf, requestEmbedBound(r)), Draft: draft})
}

func PublishWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, perms, ok := WorkflowScopeGrants(s, w, r, authz.PermWorkflowPublish)
	if !ok {
		return
	}
	var req publishRequest
	if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	draft, err := s.Workflows.GetDraft(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if refs := opsconfig.ExtractRefs(draft.DefinitionYAML); len(refs) > 0 && s.Ops != nil {
		if _, err := s.Ops.Resolve(r.Context(), scope, refs); err != nil {
			WriteOpsError(w, r, err)
			return
		}
	}
	wf, ver, err := s.Workflows.Publish(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), wfstore.PublishInput{
		ExpectedRevision: req.Revision,
		Note:             req.Note,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	pins, ok := PinWorkflowRefs(s, w, r, scope, ver.DefinitionYAML, opsconfig.OwnerWorkflowVersion, ver.ID)
	if !ok {
		return
	}
	scriptPins, ok := publishWorkflowScripts(s, w, r, scope, ver.DefinitionYAML, ver.ID, pins)
	if !ok {
		return
	}
	core.WriteJSON(w, http.StatusCreated, PublishResponse{Workflow: presentWorkflow(perms, scope.ActorID(), wf, requestEmbedBound(r)), Version: ver, Pins: pins, ScriptArtifacts: scriptPins})
}

func listWorkflowVersions(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	q, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	items, next, err := s.Workflows.ListVersionsPage(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), q)
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WritePage(w, items, q, next)
}

func getWorkflowVersion(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	ver, err := s.Workflows.GetVersion(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("versionId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, ver)
}

// workflowExportFilename is the ASCII filename= fallback. Quotes,
// backslashes, control characters, and path separators are stripped.
// An empty result uses the workflow slug, then workflow.yaml.
func workflowExportFilename(name, slug string, version int) string {
	if base := exportNameBase(name, true); base != "" {
		return base + ".v" + strconv.Itoa(version) + ".yaml"
	}
	if base := exportNameBase(slug, true); base != "" {
		return base + ".v" + strconv.Itoa(version) + ".yaml"
	}
	return "workflow.yaml"
}

// preferredExportFilename keeps non-ASCII letters for filename* after
// stripping quotes, backslashes, controls, and path separators.
func preferredExportFilename(name string, version int) string {
	base := exportNameBase(name, false)
	if base == "" {
		return ""
	}
	return base + ".v" + strconv.Itoa(version) + ".yaml"
}

func exportNameBase(name string, asciiOnly bool) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(name) {
		if exportRuneStripped(r, asciiOnly) {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if strings.Trim(out, "-. ") == "" {
		return ""
	}
	return out
}

func exportRuneStripped(r rune, asciiOnly bool) bool {
	if r < 0x20 || r == 0x7F || unicode.IsControl(r) {
		return true
	}
	switch r {
	case '"', '\\', '/', ';':
		return true
	}
	return asciiOnly && r > 0x7E
}

// exportContentDisposition emits an ASCII filename fallback plus an
// RFC 5987 filename* when the display name is not ASCII. Both parameters
// come from mime.FormatMediaType.
func exportContentDisposition(name, slug string, version int) string {
	fallback := workflowExportFilename(name, slug, version)
	header := mime.FormatMediaType("attachment", map[string]string{
		"filename": fallback,
	})
	if header == "" {
		header = mime.FormatMediaType("attachment", map[string]string{
			"filename": "workflow.yaml",
		})
	}
	preferred := preferredExportFilename(name, version)
	if preferred == "" || preferred == fallback {
		return header
	}
	encoded := mime.FormatMediaType("attachment", map[string]string{
		"filename": preferred,
	})
	if i := strings.Index(encoded, "filename*="); i >= 0 {
		return header + "; " + encoded[i:]
	}
	return header
}

func exportWorkflowVersion(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	ver, err := s.Workflows.GetVersion(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("versionId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	slug := ""
	if wf, gerr := s.Workflows.Get(r.Context(), scope, ver.WorkflowID); gerr == nil {
		slug = wf.Slug
	}
	filename := preferredExportFilename(ver.Summary.Name, ver.VersionNumber)
	if filename == "" {
		filename = workflowExportFilename(ver.Summary.Name, slug, ver.VersionNumber)
	}
	disposition := exportContentDisposition(ver.Summary.Name, slug, ver.VersionNumber)
	payload := ExportResponse{
		WorkflowID:     ver.WorkflowID,
		VersionID:      ver.ID,
		VersionNumber:  ver.VersionNumber,
		Digest:         ver.Digest,
		Filename:       filename,
		DefinitionYAML: ver.DefinitionYAML,
	}
	if wantsYAML(r) {
		w.Header().Set("Content-Type", "application/yaml")
		w.Header().Set("Content-Disposition", disposition)
		w.Header().Set("X-FlowForge-Digest", ver.Digest)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(ver.DefinitionYAML))
		return
	}
	w.Header().Set("Content-Disposition", disposition)
	core.WriteJSON(w, http.StatusOK, payload)
}

func compareWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	var req compareRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if strings.TrimSpace(req.Left.Kind) == "" || strings.TrimSpace(req.Right.Kind) == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "left.kind and right.kind are required (draft or version).")
		return
	}
	out, err := s.Workflows.Compare(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), req.Left, req.Right)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

func restoreWorkflowVersion(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, perms, ok := WorkflowScopeGrants(s, w, r, authz.PermWorkflowEdit)
	if !ok {
		return
	}
	var req restoreRequest
	if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	wf, draft, err := s.Workflows.Restore(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), wfstore.RestoreInput{
		VersionID:        strings.TrimSpace(r.PathValue("versionId")),
		ExpectedRevision: req.ExpectedRevision,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, WorkflowDetailResponse{Workflow: presentWorkflow(perms, scope.ActorID(), wf, requestEmbedBound(r)), Draft: draft})
}

func startWorkflowExecution(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	var req startExecutionRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if req.Draft != nil && *req.Draft || strings.EqualFold(req.Source, "draft") || strings.TrimSpace(req.WorkflowDraftID) != "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Drafts cannot be executed. Select a published workflow version.")
		return
	}
	if strings.TrimSpace(req.WorkflowVersionID) == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Drafts cannot be executed. Select a published workflow version.")
		return
	}
	workflowID := strings.TrimSpace(r.PathValue("workflowId"))
	start := wfstore.StartInput{
		VersionID:      req.WorkflowVersionID,
		IdempotencyKey: core.FirstNonEmpty(strings.TrimSpace(req.IdempotencyKey), strings.TrimSpace(r.Header.Get("Idempotency-Key"))),
		Input:          req.Input,
		CorrelationID:  core.FirstNonEmpty(strings.TrimSpace(req.CorrelationID), core.RequestIDFromContext(r.Context())),
		TriggerID:      strings.TrimSpace(req.TriggerID),
		HostContext:    map[string]any{"requestId": core.RequestIDFromContext(r.Context())},
	}
	ver, err := s.Workflows.GetVersion(r.Context(), scope, workflowID, req.WorkflowVersionID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if errs := workflow.ValidateManualStartInput(req.Input, ver.DefinitionYAML); len(errs) > 0 {
		WriteManualStartInputErrors(w, r, errs)
		return
	}
	if start.IdempotencyKey != "" {
		existing, peekErr := s.Workflows.PeekIdempotent(r.Context(), scope, workflowID, start)
		if peekErr == nil {
			WriteExecutionDetail(s, w, r, scope, existing, http.StatusOK)
			return
		}
		if !errors.Is(peekErr, wfstore.ErrNotFound) {
			s.EmitSecurityError(r, scope, peekErr)
			writeManualStartAudit(s, r, scope, workflowID, ver, start, "", "denied", map[string]any{"reason": "idempotency-fingerprint-mismatch"})
			WriteWorkflowStoreError(w, r, peekErr)
			return
		}
	}
	if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 && s.Ops != nil {
		if _, err := s.Ops.Resolve(r.Context(), scope, refs); err != nil {
			WriteOpsError(w, r, err)
			return
		}
	}
	preUser, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	_, _, _, prePerms, ok := s.RequireAccess(w, r, preUser, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	if !authorizeScriptNodes(s, w, r, prePerms, ver.DefinitionYAML) {
		return
	}
	if !VerifyWorkflowScriptPins(s, w, r, scope, ver.DefinitionYAML, ver.ID) {
		return
	}
	if s.Approvals != nil {
		eval, evalErr := approvalhttp.EvaluateVersion(s, r.Context(), scope, workflowID, req.WorkflowVersionID)
		if evalErr != nil {
			approvalhttp.WriteApprovalEvalError(w, r, evalErr)
			return
		}
		if eval.Decision == policy.DecisionDeny {
			s.EmitAlert(r, scope, opsalert.Signal{
				Kind:         opsalert.KindPolicy,
				Action:       "workflow.execute",
				ResourceType: "workflow",
				ResourceID:   workflowID,
				Code:         core.CodeForbidden,
				Details:      map[string]any{"reason": "policy-deny"},
			})
			writeManualStartAudit(s, r, scope, workflowID, ver, start, "", "denied", map[string]any{"reason": "policy-deny"})
			core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", approvalhttp.DenyDetail(eval))
			return
		}
		if _, gateErr := approvalhttp.DispatchApprovalsOK(s, r.Context(), scope, eval, workflowID, ver.ID); gateErr != nil {
			if errors.Is(gateErr, approvalhttp.ErrPolicyDenied) {
				s.EmitAlert(r, scope, opsalert.Signal{
					Kind:         opsalert.KindPolicy,
					Action:       "workflow.execute",
					ResourceType: "workflow",
					ResourceID:   workflowID,
					Code:         core.CodeForbidden,
					Details:      map[string]any{"reason": "policy-deny"},
				})
				writeManualStartAudit(s, r, scope, workflowID, ver, start, "", "denied", map[string]any{"reason": "policy-deny"})
				core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", approvalhttp.DenyDetail(eval))
				return
			}
			if errors.Is(gateErr, approvalhttp.ErrApprovalRequired) {
				writeManualStartAudit(s, r, scope, workflowID, ver, start, "", "denied", map[string]any{"reason": "approval-required"})
				core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Dispatch requires a valid approval bound to the current workflow version, target, policy revision, and operation.")
				return
			}
			approvalhttp.WriteApprovalError(w, r, gateErr)
			return
		}
	}
	exec, err := s.Workflows.StartExecution(r.Context(), scope, workflowID, s.CapStart(start))
	if err != nil {
		s.EmitSecurityError(r, scope, err)
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if exec.Replayed {
		WriteExecutionDetail(s, w, r, scope, exec, http.StatusOK)
		return
	}
	pins := []opsconfig.Pin{}
	if s.Ops != nil {
		copied, copyErr := s.Ops.CopyPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID)
		if copyErr != nil {
			WriteOpsError(w, r, copyErr)
			return
		}
		if len(copied) == 0 {
			var ok bool
			pins, ok = PinWorkflowRefs(s, w, r, scope, ver.DefinitionYAML, opsconfig.OwnerExecution, exec.ID)
			if !ok {
				return
			}
		} else {
			pins = copied
		}
	}
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	_, _, _, perms, ok := s.RequireAccess(w, r, user, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	if !authorizeExecutionPins(s, w, r, perms, pins) {
		return
	}
	if !authorizeKubernetesNodes(s, w, r, perms, ver.DefinitionYAML) {
		return
	}
	if !authorizeSSHNodes(s, w, r, perms, ver.DefinitionYAML) {
		return
	}
	if !authorizeHTTPNodes(s, w, r, perms, ver.DefinitionYAML) {
		return
	}
	approval.RememberRun(s.Approvals, exec.ID, exec.WorkflowVersionID, exec.WorkflowDigest, pins)
	WriteExecutionDetail(s, w, r, scope, exec, http.StatusCreated)
}

func authorizeKubernetesNodes(s *core.Server, w http.ResponseWriter, r *http.Request, perms []string, yamlDoc string) bool {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return true
	}
	for _, node := range res.Document.Spec.Nodes {
		needed := k8sengine.RequiredPermissions(node.Type)
		if len(needed) == 1 && needed[0] == authz.PermWorkflowExecute {
			continue
		}
		if !strings.HasPrefix(node.Type, "kubernetes.") {
			continue
		}
		for _, perm := range needed {
			if !authz.Allows(perms, perm) {
				core.WriteForbidden(w, r)
				return false
			}
		}
	}
	return true
}

func getWorkflowExecution(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	exec, err := s.Workflows.GetExecution(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	WriteExecutionDetail(s, w, r, scope, exec, http.StatusOK)
}

func WorkflowScope(s *core.Server, w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	scope, _, ok := WorkflowScopeGrants(s, w, r, perm)
	return scope, ok
}

func WorkflowScopeGrants(s *core.Server, w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, []string, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, nil, false
	}
	if !requireWorkflowStore(s, w, r) {
		return isolation.Scope{}, nil, false
	}
	return s.RequireScopeGrants(w, r, user, perm)
}

func readDraftSave(w http.ResponseWriter, r *http.Request) ([]byte, int64, bool) {
	ct := r.Header.Get("Content-Type")
	mediaType := ""
	if ct != "" {
		var err error
		mediaType, _, err = mime.ParseMediaType(ct)
		if err != nil {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json or application/yaml.")
			return nil, 0, false
		}
	}
	switch mediaType {
	case "application/json":
		var req saveDraftRequest
		if !core.DecodeJSON(w, r, &req) {
			return nil, 0, false
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return nil, 0, false
		}
		if strings.TrimSpace(req.DefinitionYAML) == "" {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "definitionYaml is required.")
			return nil, 0, false
		}
		if req.Revision < 1 {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "revision is required for a conflict-safe draft save.")
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
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "If-Match must be the current draft revision.")
			return nil, 0, false
		}
		return src, rev, true
	default:
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Content-Type must be application/json or application/yaml.")
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

func wantsYAML(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	return strings.Contains(accept, "application/yaml") || strings.Contains(accept, "text/yaml")
}

func WriteManualStartInputErrors(w http.ResponseWriter, r *http.Request, errs workflow.ErrorList) {
	out := make([]core.FieldError, 0, len(errs))
	for _, e := range errs {
		out = append(out, core.FieldError{
			Path:    e.Path,
			Line:    e.Line,
			Column:  e.Column,
			Code:    e.Code,
			Message: e.Message,
		})
	}
	detail := "Start input is not valid."
	if len(out) == 1 && out[0].Message != "" {
		detail = out[0].Message
	}
	core.WriteProblemErrors(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", detail, out)
}

func writeManualStartAudit(s *core.Server, r *http.Request, scope isolation.Scope, workflowID string, ver wfstore.Version, start wfstore.StartInput, executionID, outcome string, extra map[string]any) {
	if s.Workflows == nil {
		return
	}
	details := map[string]any{
		"actorId":           scope.ActorID(),
		"workflowId":        workflowID,
		"workflowVersionId": ver.ID,
		"workflowDigest":    ver.Digest,
		"triggerType":       "manual",
		"correlationId":     core.FirstNonEmpty(start.CorrelationID, core.RequestIDFromContext(r.Context())),
		"outcome":           outcome,
	}
	if start.IdempotencyKey != "" {
		details["idempotencyKey"] = start.IdempotencyKey
	}
	for k, v := range extra {
		details[k] = v
	}
	_, _ = s.Workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        "execution.start",
		ResourceType:  core.FirstNonEmpty(resourceTypeForStart(executionID), "workflow"),
		ResourceID:    core.FirstNonEmpty(executionID, workflowID),
		Outcome:       outcome,
		CorrelationID: core.FirstNonEmpty(start.CorrelationID, core.RequestIDFromContext(r.Context())),
		HostContext:   map[string]any{"requestId": core.RequestIDFromContext(r.Context())},
		Details:       details,
	})
}

func resourceTypeForStart(executionID string) string {
	if strings.TrimSpace(executionID) != "" {
		return "execution"
	}
	return "workflow"
}

func writeSlugInvalid(w http.ResponseWriter, r *http.Request) {
	detail := workflow.WorkflowSlugInvalidMessage("slug")
	core.WriteProblemErrors(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", detail, []core.FieldError{{
		Path:    "slug",
		Code:    core.CodeInvalidRequest,
		Message: detail,
	}})
}

func writeSlugConflict(w http.ResponseWriter, r *http.Request, conflict wfstore.SlugConflict) {
	code := core.CodeConflict
	detail := "A workflow with this slug already exists."
	switch {
	case conflict.Reserved:
		code = core.CodeWorkflowSlugReserved
		detail = "This slug is reserved by a deleted workflow."
	case conflict.Exhausted:
		detail = "A unique slug could not be allocated."
	}
	core.WriteProblemErrors(w, r, http.StatusConflict, code, "Conflict", detail, []core.FieldError{{
		Path:    "slug",
		Code:    code,
		Message: detail,
	}})
}

func WriteWorkflowStoreError(w http.ResponseWriter, r *http.Request, err error) {
	var slugConflict wfstore.SlugConflict
	if errors.As(err, &slugConflict) {
		writeSlugConflict(w, r, slugConflict)
		return
	}
	var refused *wfstore.NotRetryableError
	if errors.As(err, &refused) {
		core.WriteProblemReason(w, r, http.StatusConflict, core.CodeExecutionNotRetryable, "Conflict", "This execution cannot be retried.", refused.Reason)
		return
	}
	switch {
	case errors.Is(err, wfstore.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, wfstore.ErrRevisionConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Draft revision does not match the current saved revision.")
	case errors.Is(err, wfstore.ErrDuplicateVersion):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "This normalized definition is already published.")
	case errors.Is(err, wfstore.ErrActiveExecutions):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeWorkflowHasActiveExecutions, "Conflict", "This workflow has a job that is queued, claimed, or running.")
	case errors.Is(err, wfstore.ErrSlugReserved):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeWorkflowSlugReserved, "Conflict", "This slug is reserved by a deleted workflow.")
	case errors.Is(err, wfstore.ErrWorkflowDeleted):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeWorkflowDeleted, "Conflict", "This workflow was deleted. The run will not continue.")
	case errors.Is(err, wfstore.ErrStepAttemptSuperseded):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeStepAttemptSuperseded, "Conflict", "This step attempt was superseded by a later attempt.")
	case errors.Is(err, wfstore.ErrExecutionNotRetryable):
		core.WriteProblemReason(w, r, http.StatusConflict, core.CodeExecutionNotRetryable, "Conflict", "This execution cannot be retried.", "")
	case errors.Is(err, wfstore.ErrConstraint):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "The request conflicts with an existing record.")
	case errors.Is(err, wfstore.ErrConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "A workflow with this slug already exists.")
	case errors.Is(err, wfstore.ErrImmutable):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Published versions are immutable.")
	case errors.Is(err, wfstore.ErrDraftNotRunnable):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Drafts cannot be executed. Select a published workflow version.")
	case errors.Is(err, wfstore.ErrConcurrency):
		core.WriteRateLimited(w, r, time.Second, "Workspace execution concurrency limit exceeded. Retry after an open execution finishes.")
	case errors.Is(err, wfstore.ErrIdempotencyKeyInvalid):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Idempotency key must be 1-128 characters matching [A-Za-z0-9._~:-].")
	case errors.Is(err, wfstore.ErrIdempotencyConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Idempotency key was reused with a different request fingerprint.")
	case errors.Is(err, wfstore.ErrFenceConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Fencing token does not match the active lease.")
	case errors.Is(err, wfstore.ErrLeaseExpired):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "The job lease has expired.")
	case errors.Is(err, wfstore.ErrJobExpired):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "The authenticated job ticket has expired.")
	case errors.Is(err, wfstore.ErrJobBinding):
		core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", "The authenticated job binding was rejected.")
	case errors.Is(err, wfstore.ErrRetryDenied), errors.Is(err, wfstore.ErrRetryNotAllowed):
		core.WriteProblemReason(w, r, http.StatusConflict, core.CodeExecutionNotRetryable, "Conflict", "This execution cannot be retried.", wfstore.ReasonRetryNotAllowed)
	case errors.Is(err, wfstore.ErrEmergencyStopNotApplicable):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Emergency stop applies only to an open script.python or script.go step.")
	case errors.Is(err, wfstore.ErrNotClaimable), errors.Is(err, wfstore.ErrAlreadyTerminal), errors.Is(err, wfstore.ErrCanceled):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "The job or execution cannot be updated in its current state.")
	case errors.Is(err, wfstore.ErrUnsafeArtifact):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Unsafe artifact content was rejected before upload.")
	case errors.Is(err, wfstore.ErrArtifactExpired), errors.Is(err, wfstore.ErrGrantExpired):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, wfstore.ErrLegalHold):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Artifact is under legal hold.")
	case errors.Is(err, artifact.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, vault.ErrKeyUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Artifact encryption key is not configured.")
	case errors.Is(err, wfstore.ErrInvalid), errors.Is(err, wfstore.ErrNoScope):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, wfstore.ErrStoreUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
	default:
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
