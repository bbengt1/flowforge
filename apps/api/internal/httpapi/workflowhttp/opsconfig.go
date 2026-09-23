package workflowhttp

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/vaulthttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpnotify"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	ssheng "github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
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

type OpsDetailResponse struct {
	Resource opsconfig.Resource `json:"resource"`
	Draft    opsconfig.Draft    `json:"draft"`
}

type OpsPublishResponse struct {
	Resource opsconfig.Resource `json:"resource"`
	Version  opsconfig.Version  `json:"version"`
}

func requireOps(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.Ops != nil {
		return true
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Operational configuration store is not available.")
	return false
}

func opsScope(s *core.Server, w http.ResponseWriter, r *http.Request, perm string) (isolation.Scope, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, false
	}
	if !requireOps(s, w, r) {
		return isolation.Scope{}, false
	}
	return s.RequireScope(w, r, user, perm)
}

func getOpsCatalog(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	_ = scope
	core.WriteJSON(w, http.StatusOK, opsconfig.TypeCatalogWithGate(workflow.IntegrationActionsEnabled))
}

func listOpsResources(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		q, ok := core.ParsePage(w, r)
		if !ok {
			return
		}
		items, next, err := s.Ops.ListPage(r.Context(), scope, kind, q)
		if core.RejectPageErr(w, r, err) {
			return
		}
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WritePage(w, items, q, next)
	}
}

func CreateOpsResource(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		var req createOpsRequest
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if !authorizeOpsSpec(s, w, r, scope, kind, req.Spec, false) {
			return
		}
		rec, draft, err := s.Ops.Create(r.Context(), scope, opsconfig.CreateInput{
			Kind: kind,
			Slug: req.Slug,
			Name: req.Name,
			Spec: req.Spec,
		})
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusCreated, OpsDetailResponse{Resource: rec, Draft: draft})
	}
}

func getOpsResource(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		rec, err := s.Ops.Get(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusOK, rec)
	}
}

func getOpsDraft(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		draft, err := s.Ops.GetDraft(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusOK, draft)
	}
}

func putOpsDraft(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		var req saveOpsDraftRequest
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
		if !authorizeOpsSpec(s, w, r, scope, kind, req.Spec, false) {
			return
		}
		rec, draft, err := s.Ops.SaveDraft(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), opsconfig.SaveInput{
			ExpectedRevision: req.Revision,
			Name:             req.Name,
			Spec:             req.Spec,
		})
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusOK, OpsDetailResponse{Resource: rec, Draft: draft})
	}
}

func publishOpsResource(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigPublish)
		if !ok {
			return
		}
		var req publishOpsRequest
		if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
			if !core.DecodeJSON(w, r, &req) {
				return
			}
			if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
				core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
				return
			}
		}
		draft, err := s.Ops.GetDraft(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		if !authorizeOpsSpec(s, w, r, scope, kind, draft.Spec, true) {
			return
		}
		rec, ver, err := s.Ops.Publish(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), opsconfig.PublishInput{
			ExpectedRevision: req.Revision,
			Note:             req.Note,
		})
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		reason := "target revision changed"
		if kind == opsconfig.KindPolicy {
			reason = "policy revision changed"
		}
		approvalhttp.InvalidateApprovalsForResource(s, r.Context(), scope, rec.ID, reason)
		core.WriteJSON(w, http.StatusCreated, OpsPublishResponse{Resource: rec, Version: ver})
	}
}

func listOpsVersions(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		q, ok := core.ParsePage(w, r)
		if !ok {
			return
		}
		items, next, err := s.Ops.ListVersionsPage(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), q)
		if core.RejectPageErr(w, r, err) {
			return
		}
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WritePage(w, items, q, next)
	}
}

func getOpsVersion(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		ver, err := s.Ops.GetVersion(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), strings.TrimSpace(r.PathValue("versionId")))
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusOK, ver)
	}
}

func disableOpsResource(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		rec, err := s.Ops.Disable(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		approvalhttp.InvalidateApprovalsForResource(s, r.Context(), scope, rec.ID, "resource is disabled")
		core.WriteJSON(w, http.StatusOK, rec)
	}
}

func enableOpsResource(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigEdit)
		if !ok {
			return
		}
		rec, err := s.Ops.Enable(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")))
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		core.WriteJSON(w, http.StatusOK, rec)
	}
}

func selectOpsResource(s *core.Server, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
		if !ok {
			return
		}
		var req selectOpsRequest
		if r.ContentLength != 0 && r.Header.Get("Content-Type") != "" {
			if !core.DecodeJSON(w, r, &req) {
				return
			}
			if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
				core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
				return
			}
		}
		pin, err := s.Ops.Select(r.Context(), scope, kind, strings.TrimSpace(r.PathValue("resourceId")), opsconfig.SelectInput{VersionID: req.VersionID})
		if err != nil {
			WriteOpsError(w, r, err)
			return
		}
		if !authorizeOpsSpec(s, w, r, scope, kind, pin.Spec, true) {
			return
		}
		core.WriteJSON(w, http.StatusOK, pin)
	}
}

func selectOpsBatch(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	var req batchSelectRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	if len(req.Refs) == 0 {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "refs is required.")
		return
	}
	pins, err := s.Ops.Resolve(r.Context(), scope, req.Refs)
	if err != nil {
		WriteOpsError(w, r, err)
		return
	}
	for _, pin := range pins {
		if !authorizeOpsSpec(s, w, r, scope, pin.Kind, pin.Spec, true) {
			return
		}
	}
	core.WriteJSON(w, http.StatusOK, core.ListResponse[opsconfig.Pin]{Items: pins})
}

func listWorkflowVersionPins(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	if !requireOps(s, w, r) {
		return
	}
	if _, err := s.Workflows.GetVersion(r.Context(), scope, strings.TrimSpace(r.PathValue("workflowId")), strings.TrimSpace(r.PathValue("versionId"))); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	pins, err := s.Ops.ListPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, strings.TrimSpace(r.PathValue("versionId")))
	if err != nil {
		WriteOpsError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.ListResponse[opsconfig.Pin]{Items: pins})
}

func getKubernetesCatalog(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	_ = scope
	core.WriteJSON(w, http.StatusOK, kubernetes.Catalog())
}

func getSSHCatalog(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	_ = scope
	core.WriteJSON(w, http.StatusOK, ssheng.Catalog())
}

func getHTTPCatalog(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := opsScope(s, w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	_ = scope
	core.WriteJSON(w, http.StatusOK, httpnotify.CatalogWithEnabled(workflow.IntegrationActionsEnabled))
}

func authorizeOpsSpec(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, kind string, spec map[string]any, ready bool) bool {
	if spec == nil {
		spec = map[string]any{}
	}
	if !authorizeCredentialSpec(s, w, r, scope, kind, spec) {
		return false
	}
	if kind == opsconfig.KindClusterTarget && !authorizeClusterTargetPolicy(s, w, r, scope, spec) {
		return false
	}
	if (kind == opsconfig.KindSSHTarget || kind == opsconfig.KindCommandProfile) && !authorizeSSHPolicy(s, w, r, scope, spec) {
		return false
	}
	if ready {
		if err := opsconfig.ValidateReady(kind, spec); err != nil {
			WriteOpsError(w, r, err)
			return false
		}
	}
	return true
}

func authorizeCredentialSpec(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, kind string, spec map[string]any) bool {
	if spec == nil || s.Vault == nil {
		return true
	}
	raw, _ := spec["credentialId"].(string)
	id := strings.TrimSpace(raw)
	if id == "" {
		return true
	}
	meta, err := s.Vault.Get(r.Context(), scope, id)
	if err != nil {
		vaulthttp.WriteVaultError(w, r, err)
		return false
	}
	if kind == opsconfig.KindClusterTarget && meta.Type != vault.TypeKubernetes && meta.Type != kubernetes.CredentialType {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Cluster targets require a workspace kubernetes (kubeconfig) credential.")
		return false
	}
	if kind == opsconfig.KindSSHTarget && meta.Type != vault.TypeSSHPrivateKey && meta.Type != ssheng.CredentialType {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "SSH targets require a workspace ssh_private_key credential.")
		return false
	}
	if kind == opsconfig.KindConnection && meta.Type != vault.TypeToken && meta.Type != httpnotify.CredentialType {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Connections require a workspace token credential.")
		return false
	}
	if meta.Status == vault.StatusDisabled {
		vaulthttp.WriteVaultError(w, r, vault.ErrDisabled)
		return false
	}
	return true
}

func authorizeClusterTargetPolicy(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, spec map[string]any) bool {
	policyID := strings.TrimSpace(stringField(spec, "policyId"))
	if policyID == "" {
		return true
	}
	rec, err := s.Ops.Get(r.Context(), scope, opsconfig.KindPolicy, policyID)
	if err != nil {
		WriteOpsError(w, r, err)
		return false
	}
	var policySpec map[string]any
	if rec.Status == opsconfig.StatusPublished && rec.LatestVersionID != "" {
		ver, verErr := s.Ops.GetVersion(r.Context(), scope, opsconfig.KindPolicy, policyID, rec.LatestVersionID)
		if verErr != nil {
			WriteOpsError(w, r, verErr)
			return false
		}
		policySpec = ver.Spec
	} else {
		draft, draftErr := s.Ops.GetDraft(r.Context(), scope, opsconfig.KindPolicy, policyID)
		if draftErr != nil {
			WriteOpsError(w, r, draftErr)
			return false
		}
		policySpec = draft.Spec
	}
	if kind, _ := policySpec["kind"].(string); kind != "" && kind != "kubernetes" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Cluster targets must bind a kubernetes policy.")
		return false
	}
	if err := opsconfig.TargetNamespacesConsistent(spec, policySpec); err != nil {
		WriteOpsError(w, r, err)
		return false
	}
	return true
}

func authorizeSSHPolicy(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, spec map[string]any) bool {
	policyID := strings.TrimSpace(stringField(spec, "policyId"))
	if policyID == "" {
		return true
	}
	rec, err := s.Ops.Get(r.Context(), scope, opsconfig.KindPolicy, policyID)
	if err != nil {
		WriteOpsError(w, r, err)
		return false
	}
	var policySpec map[string]any
	if rec.Status == opsconfig.StatusPublished && rec.LatestVersionID != "" {
		ver, verErr := s.Ops.GetVersion(r.Context(), scope, opsconfig.KindPolicy, policyID, rec.LatestVersionID)
		if verErr != nil {
			WriteOpsError(w, r, verErr)
			return false
		}
		policySpec = ver.Spec
	} else {
		draft, draftErr := s.Ops.GetDraft(r.Context(), scope, opsconfig.KindPolicy, policyID)
		if draftErr != nil {
			WriteOpsError(w, r, draftErr)
			return false
		}
		policySpec = draft.Spec
	}
	if kind, _ := policySpec["kind"].(string); kind != "" && kind != "ssh" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "SSH targets and command profiles must bind an ssh policy.")
		return false
	}
	if strings.TrimSpace(stringField(spec, "hostname")) != "" {
		if err := opsconfig.TargetAddressesConsistent(spec, policySpec); err != nil {
			WriteOpsError(w, r, err)
			return false
		}
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

func PinWorkflowRefs(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, yamlDoc, ownerKind, ownerID string) ([]opsconfig.Pin, bool) {
	if s.Ops == nil {
		return []opsconfig.Pin{}, true
	}
	refs := opsconfig.ExtractRefs(yamlDoc)
	if len(refs) == 0 {
		if existing, err := s.Ops.ListPins(r.Context(), scope, ownerKind, ownerID); err == nil && len(existing) > 0 {
			return existing, true
		}
		if _, err := s.Ops.BindPins(r.Context(), scope, opsconfig.BindInput{OwnerKind: ownerKind, OwnerID: ownerID}); err != nil && !errors.Is(err, opsconfig.ErrImmutable) {
			WriteOpsError(w, r, err)
			return nil, false
		}
		return []opsconfig.Pin{}, true
	}
	pins, err := s.Ops.Resolve(r.Context(), scope, refs)
	if err != nil {
		WriteOpsError(w, r, err)
		return nil, false
	}
	for _, pin := range pins {
		if !authorizeOpsSpec(s, w, r, scope, pin.Kind, pin.Spec, true) {
			return nil, false
		}
	}
	if !validateSSHRunPins(s, w, r, yamlDoc, pins) {
		return nil, false
	}
	if !validateHTTPPins(s, w, r, yamlDoc, pins) {
		return nil, false
	}
	bound, err := s.Ops.BindPins(r.Context(), scope, opsconfig.BindInput{OwnerKind: ownerKind, OwnerID: ownerID, Pins: pins})
	if err != nil {
		if errors.Is(err, opsconfig.ErrImmutable) {
			existing, listErr := s.Ops.ListPins(r.Context(), scope, ownerKind, ownerID)
			if listErr != nil {
				WriteOpsError(w, r, listErr)
				return nil, false
			}
			return existing, true
		}
		WriteOpsError(w, r, err)
		return nil, false
	}
	return bound, true
}

func authorizeExecutionPins(s *core.Server, w http.ResponseWriter, r *http.Request, perms []string, pins []opsconfig.Pin) bool {
	for _, pin := range pins {
		use := opsconfig.UsePermissionFor(pin.Kind)
		if use == "" {
			continue
		}
		if pin.Kind == opsconfig.KindSSHTarget || pin.Kind == opsconfig.KindCommandProfile {
			if !authz.Allows(perms, use) {
				core.WriteForbidden(w, r)
				return false
			}
			continue
		}
		if !authz.Allows(perms, authz.PermOpsConfigUse) && !authz.Allows(perms, use) {
			core.WriteForbidden(w, r)
			return false
		}
	}
	return true
}

func authorizeSSHNodes(s *core.Server, w http.ResponseWriter, r *http.Request, perms []string, yamlDoc string) bool {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return true
	}
	for _, node := range res.Document.Spec.Nodes {
		if node.Type != ssheng.NodeSSHRun {
			continue
		}
		for _, perm := range ssheng.RequiredPermissions() {
			if !authz.Allows(perms, perm) {
				core.WriteForbidden(w, r)
				return false
			}
		}
	}
	return true
}

func validateSSHRunPins(s *core.Server, w http.ResponseWriter, r *http.Request, yamlDoc string, pins []opsconfig.Pin) bool {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return true
	}
	profiles := map[string]opsconfig.Pin{}
	for _, pin := range pins {
		if pin.Kind == opsconfig.KindCommandProfile {
			profiles[pin.ResourceID] = pin
		}
	}
	for _, node := range res.Document.Spec.Nodes {
		if node.Type != ssheng.NodeSSHRun {
			continue
		}
		profileID, _ := node.With["commandProfileId"].(string)
		profileID = strings.TrimSpace(profileID)
		pin, ok := profiles[profileID]
		if !ok {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "ssh.run requires a pinned command profile revision.")
			return false
		}
		params, _ := node.With["parameters"].(map[string]any)
		if err := opsconfig.ValidateSSHRunParameters(pin.Spec, params); err != nil {
			WriteOpsError(w, r, err)
			return false
		}
		if err := opsconfig.ValidateSSHRunRetry(pin.Spec, node.With); err != nil {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeRetryDenied, "Retry Denied", "retryPolicy.maxAttempts>0 requires a retrySafe command profile with a verification probe.")
			return false
		}
	}
	return true
}

func authorizeHTTPNodes(s *core.Server, w http.ResponseWriter, r *http.Request, perms []string, yamlDoc string) bool {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return true
	}
	for _, node := range res.Document.Spec.Nodes {
		needed := httpnotify.RequiredPermissions(node.Type)
		if len(needed) == 0 || httpnotify.ExpectedConnectionType(node.Type) == "" {
			continue
		}
		if node.Type == httpnotify.NodeHTTPRequest && strings.TrimSpace(stringField(node.With, "responseSchemaRef")) == "" {
			filtered := needed[:0]
			for _, perm := range needed {
				if perm == authz.PermResponseSchemaUse {
					continue
				}
				filtered = append(filtered, perm)
			}
			needed = filtered
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

func validateHTTPPins(s *core.Server, w http.ResponseWriter, r *http.Request, yamlDoc string, pins []opsconfig.Pin) bool {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return true
	}
	byID := map[string]opsconfig.Pin{}
	for _, pin := range pins {
		byID[pin.ResourceID] = pin
	}
	for _, node := range res.Document.Spec.Nodes {
		want := httpnotify.ExpectedConnectionType(node.Type)
		if want == "" {
			continue
		}
		connID := strings.TrimSpace(stringField(node.With, "connectionId"))
		pin, ok := byID[connID]
		if !ok || pin.Kind != opsconfig.KindConnection {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", node.Type+" requires a pinned connection revision.")
			return false
		}
		if err := opsconfig.ValidateHTTPConnectionType(node.Type, pin.Spec); err != nil {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Pinned connection type does not match "+node.Type+".")
			return false
		}
	}
	return true
}

func WriteOpsError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, opsconfig.ErrNotFound), errors.Is(err, opsconfig.ErrCrossWorkspace):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, opsconfig.ErrRevisionConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Draft revision does not match the current saved revision.")
	case errors.Is(err, opsconfig.ErrConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "An operational configuration resource with this slug or digest already exists.")
	case errors.Is(err, opsconfig.ErrImmutable):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Published revisions and pins are immutable.")
	case errors.Is(err, opsconfig.ErrDisabled):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Resource is disabled.")
	case errors.Is(err, opsconfig.ErrDraftNotUsable), errors.Is(err, opsconfig.ErrNotPublished):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Only published revisions can be selected or pinned.")
	case errors.Is(err, opsconfig.ErrInvalid), errors.Is(err, opsconfig.ErrNoScope):
		msg := "The request is not valid."
		if err != nil && strings.Contains(err.Error(), ":") {
			msg = err.Error()
		}
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", msg)
	case errors.Is(err, opsconfig.ErrStoreUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Operational configuration store is not available.")
	default:
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
