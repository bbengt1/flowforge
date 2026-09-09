package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

type createOpsRequest struct {
	ID             string         `json:"id"`
	WorkspaceID    string         `json:"workspace_id"`
	WorkspaceIDAlt string         `json:"workspaceId"`
	Slug           string         `json:"slug"`
	Name           string         `json:"name"`
	Spec           map[string]any `json:"spec"`
}

type saveOpsDraftRequest struct {
	ID             string         `json:"id"`
	WorkspaceID    string         `json:"workspace_id"`
	WorkspaceIDAlt string         `json:"workspaceId"`
	Revision       int64          `json:"revision"`
	Name           string         `json:"name"`
	Spec           map[string]any `json:"spec"`
}

type publishOpsRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Revision       int64  `json:"revision"`
	Note           string `json:"note"`
}

type selectOpsRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	VersionID      string `json:"versionId"`
}

type batchSelectRequest struct {
	ID             string          `json:"id"`
	WorkspaceID    string          `json:"workspace_id"`
	WorkspaceIDAlt string          `json:"workspaceId"`
	Refs           []opsconfig.Ref `json:"refs"`
}

type opsDetailResponse struct {
	Resource opsconfig.Resource `json:"resource"`
	Draft    opsconfig.Draft    `json:"draft"`
}

type opsPublishResponse struct {
	Resource opsconfig.Resource `json:"resource"`
	Version  opsconfig.Version  `json:"version"`
}

func (s *Server) requireOps(w http.ResponseWriter, r *http.Request) bool {
	if s.ops != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Operational configuration store is not available.")
	return false
}

func (s *Server) opsScope(w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !s.requireOps(w, r) {
		return isolation.Scope{}, false
	}
	return s.requireScope(w, r, user, perm)
}

func (s *Server) getOpsCatalog(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	_ = scope
	writeJSON(w, http.StatusOK, opsconfig.TypeCatalog())
}

func (s *Server) listOpsResources(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		items, err := s.ops.List(r.Context(), scope, kind)
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, listResponse[opsconfig.Resource]{Items: items})
	}
}

func (s *Server) createOpsResource(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		var req createOpsRequest
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if !s.authorizeOpsSpec(w, r, scope, kind, req.Spec, false) {
			return
		}
		rec, draft, err := s.ops.Create(r.Context(), scope, opsconfig.CreateInput{
			Kind: kind,
			Slug: req.Slug,
			Name: req.Name,
			Spec: req.Spec,
		})
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, opsDetailResponse{Resource: rec, Draft: draft})
	}
}

func (s *Server) getOpsResource(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		rec, err := s.ops.Get(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
	}
}

func (s *Server) getOpsDraft(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		draft, err := s.ops.GetDraft(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, draft)
	}
}

func (s *Server) putOpsDraft(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		var req saveOpsDraftRequest
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if !s.authorizeOpsSpec(w, r, scope, kind, req.Spec, false) {
			return
		}
		rec, draft, err := s.ops.SaveDraft(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), opsconfig.SaveInput{
			ExpectedRevision: req.Revision,
			Name:             req.Name,
			Spec:             req.Spec,
		})
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, opsDetailResponse{Resource: rec, Draft: draft})
	}
}

func (s *Server) publishOpsResource(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigPublish)
		if !ok {
			return
		}
		var req publishOpsRequest
		if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
			if !DecodeJSON(w, r, &req) {
				return
			}
			if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
				return
			}
		}
		draft, err := s.ops.GetDraft(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		if !s.authorizeOpsSpec(w, r, scope, kind, draft.Spec, true) {
			return
		}
		rec, ver, err := s.ops.Publish(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), opsconfig.PublishInput{
			ExpectedRevision: req.Revision,
			Note:             req.Note,
		})
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		reason := "target revision changed"
		if kind == opsconfig.KindPolicy {
			reason = "policy revision changed"
		}
		s.invalidateApprovalsForResource(r.Context(), scope, rec.ID, reason)
		writeJSON(w, http.StatusCreated, opsPublishResponse{Resource: rec, Version: ver})
	}
}

func (s *Server) listOpsVersions(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		items, err := s.ops.ListVersions(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, listResponse[opsconfig.Version]{Items: items})
	}
}

func (s *Server) getOpsVersion(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		ver, err := s.ops.GetVersion(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), strings.TrimSpace(r.PathValue("versionId")))
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, ver)
	}
}

func (s *Server) disableOpsResource(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		rec, err := s.ops.Disable(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		s.invalidateApprovalsForResource(r.Context(), scope, rec.ID, "resource is disabled")
		writeJSON(w, http.StatusOK, rec)
	}
}

func (s *Server) enableOpsResource(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		rec, err := s.ops.Enable(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
	}
}

func (s *Server) selectOpsResource(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		var req selectOpsRequest
		if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
			if !DecodeJSON(w, r, &req) {
				return
			}
			if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
				WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
				return
			}
		}
		pin, err := s.ops.Select(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), opsconfig.SelectInput{VersionID: req.VersionID})
		if err != nil {
			writeOpsError(w, r, err)
			return
		}
		if !s.authorizeOpsSpec(w, r, scope, kind, pin.Spec, true) {
			return
		}
		writeJSON(w, http.StatusOK, pin)
	}
}

func (s *Server) selectOpsBatch(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	var req batchSelectRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if len(req.Refs) == 0 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "refs is required.")
		return
	}
	pins, err := s.ops.Resolve(r.Context(), scope, req.Refs)
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	for _, pin := range pins {
		if !s.authorizeOpsSpec(w, r, scope, pin.Kind, pin.Spec, true) {
			return
		}
	}
	writeJSON(w, http.StatusOK, listResponse[opsconfig.Pin]{Items: pins})
}

func (s *Server) listWorkflowVersionPins(w http.ResponseWriter, r *http.Request) {
	if s.rejectReservedWorkflowPath(w, r) {
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	if !s.requireOps(w, r) {
		return
	}
	if _, err := s.workflows.GetVersion(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("versionId"))); err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	pins, err := s.ops.ListPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, strings.TrimSpace(r.PathValue("versionId")))
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[opsconfig.Pin]{Items: pins})
}

func (s *Server) getKubernetesCatalog(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	_ = scope
	writeJSON(w, http.StatusOK, kubernetes.Catalog())
}

func (s *Server) authorizeOpsSpec(w http.ResponseWriter, r *http.Request, scope isolation.Scope, kind string, spec map[string]any, ready bool) bool {
	if spec == nil {
		spec = map[string]any{}
	}
	if !s.authorizeCredentialSpec(w, r, scope, kind, spec) {
		return false
	}
	if kind == opsconfig.KindClusterTarget && !s.authorizeClusterTargetPolicy(w, r, scope, spec) {
		return false
	}
	if ready {
		if err := opsconfig.ValidateReady(kind, spec); err != nil {
			writeOpsError(w, r, err)
			return false
		}
	}
	return true
}

func (s *Server) authorizeCredentialSpec(w http.ResponseWriter, r *http.Request, scope isolation.Scope, kind string, spec map[string]any) bool {
	if spec == nil || s.vault == nil {
		return true
	}
	raw, _ := spec["credentialId"].(string)
	id := strings.TrimSpace(raw)
	if id == "" {
		return true
	}
	meta, err := s.vault.Get(r.Context(), scope, id)
	if err != nil {
		writeVaultError(w, r, err)
		return false
	}
	if kind == opsconfig.KindClusterTarget && meta.Type != vault.TypeKubernetes && meta.Type != kubernetes.CredentialType {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Cluster targets require a workspace kubernetes (kubeconfig) credential.")
		return false
	}
	if meta.Status == vault.StatusDisabled {
		writeVaultError(w, r, vault.ErrDisabled)
		return false
	}
	return true
}

func (s *Server) authorizeClusterTargetPolicy(w http.ResponseWriter, r *http.Request, scope isolation.Scope, spec map[string]any) bool {
	policyID := strings.TrimSpace(stringField(spec, "policyId"))
	if policyID == "" {
		return true
	}
	rec, err := s.ops.Get(r.Context(), scope, opsconfig.KindPolicy, policyID)
	if err != nil {
		writeOpsError(w, r, err)
		return false
	}
	var policySpec map[string]any
	if rec.Status == opsconfig.StatusPublished && rec.LatestVersionID != "" {
		ver, verErr := s.ops.GetVersion(r.Context(), scope, opsconfig.KindPolicy, policyID, rec.LatestVersionID)
		if verErr != nil {
			writeOpsError(w, r, verErr)
			return false
		}
		policySpec = ver.Spec
	} else {
		draft, draftErr := s.ops.GetDraft(r.Context(), scope, opsconfig.KindPolicy, policyID)
		if draftErr != nil {
			writeOpsError(w, r, draftErr)
			return false
		}
		policySpec = draft.Spec
	}
	if kind, _ := policySpec["kind"].(string); kind != "" && kind != "kubernetes" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Cluster targets must bind a kubernetes policy.")
		return false
	}
	if err := opsconfig.TargetNamespacesConsistent(spec, policySpec); err != nil {
		writeOpsError(w, r, err)
		return false
	}
	return true
}

func stringField(spec map[string]any, key string) string {
	if spec == nil {
		return ""
	}
	s, _ := spec[key].(string)
	return strings.TrimSpace(s)
}

func (s *Server) pinWorkflowRefs(w http.ResponseWriter, r *http.Request, scope isolation.Scope, yamlDoc, ownerKind, ownerID string) ([]opsconfig.Pin, bool) {
	if s.ops == nil {
		return []opsconfig.Pin{}, true
	}
	refs := opsconfig.ExtractRefs(yamlDoc)
	if len(refs) == 0 {
		if existing, err := s.ops.ListPins(r.Context(), scope, ownerKind, ownerID); err == nil && len(existing) > 0 {
			return existing, true
		}
		if _, err := s.ops.BindPins(r.Context(), scope, opsconfig.BindInput{OwnerKind: ownerKind, OwnerID: ownerID}); err != nil && !errors.Is(err, opsconfig.ErrImmutable) {
			writeOpsError(w, r, err)
			return nil, false
		}
		return []opsconfig.Pin{}, true
	}
	pins, err := s.ops.Resolve(r.Context(), scope, refs)
	if err != nil {
		writeOpsError(w, r, err)
		return nil, false
	}
	for _, pin := range pins {
		if !s.authorizeOpsSpec(w, r, scope, pin.Kind, pin.Spec, true) {
			return nil, false
		}
	}
	bound, err := s.ops.BindPins(r.Context(), scope, opsconfig.BindInput{OwnerKind: ownerKind, OwnerID: ownerID, Pins: pins})
	if err != nil {
		if errors.Is(err, opsconfig.ErrImmutable) {
			existing, listErr := s.ops.ListPins(r.Context(), scope, ownerKind, ownerID)
			if listErr != nil {
				writeOpsError(w, r, listErr)
				return nil, false
			}
			return existing, true
		}
		writeOpsError(w, r, err)
		return nil, false
	}
	return bound, true
}

func (s *Server) authorizeExecutionPins(w http.ResponseWriter, r *http.Request, perms []string, pins []opsconfig.Pin) bool {
	for _, pin := range pins {
		use := opsconfig.UsePermissionFor(pin.Kind)
		if use == "" {
			continue
		}
		if !authz.Allows(perms, authz.PermOpsConfigUse) && !authz.Allows(perms, use) {
			WriteForbidden(w, r)
			return false
		}
	}
	return true
}

func writeOpsError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, opsconfig.ErrNotFound), errors.Is(err, opsconfig.ErrCrossWorkspace):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, opsconfig.ErrRevisionConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Draft revision does not match the current saved revision.")
	case errors.Is(err, opsconfig.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "An operational configuration resource with this slug or digest already exists.")
	case errors.Is(err, opsconfig.ErrImmutable):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Published revisions and pins are immutable.")
	case errors.Is(err, opsconfig.ErrDisabled):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Resource is disabled.")
	case errors.Is(err, opsconfig.ErrDraftNotUsable), errors.Is(err, opsconfig.ErrNotPublished):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Only published revisions can be selected or pinned.")
	case errors.Is(err, opsconfig.ErrInvalid), errors.Is(err, opsconfig.ErrNoScope):
		msg := "The request is not valid."
		if err != nil && strings.Contains(err.Error(), ":") {
			msg = err.Error()
		}
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", msg)
	case errors.Is(err, opsconfig.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Operational configuration store is not available.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
