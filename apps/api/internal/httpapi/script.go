package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type revokeScriptRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Reason         string `json:"reason"`
}

type publishScriptRequest struct {
	ID                      string         `json:"id"`
	WorkspaceID             string         `json:"workspace_id"`
	WorkspaceIDAlt          string         `json:"workspaceId"`
	Language                string         `json:"language"`
	Source                  string         `json:"source"`
	Entrypoint              string         `json:"entrypoint"`
	RuntimeProfileID        string         `json:"runtimeProfileId"`
	RuntimeProfileVersionID string         `json:"runtimeProfileVersionId"`
	InputSchema             map[string]any `json:"inputSchema"`
	OutputSchema            map[string]any `json:"outputSchema"`
	TimeoutSeconds          int            `json:"timeoutSeconds"`
	MemoryMiB               int            `json:"memoryMiB"`
	CPUMillis               int            `json:"cpuMillis"`
	Processes               int            `json:"processes"`
}

func (s *Server) getScriptCatalog(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.opsScope(w, r, authz.PermOpsConfigView)
	if !ok {
		return
	}
	_ = scope
	writeJSON(w, http.StatusOK, scripts.Catalog())
}

func (s *Server) publishScript(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowPublish)
	if !ok {
		return
	}
	if !s.requireScriptPipeline(w, r) {
		return
	}
	var req publishScriptRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	pin, ok := s.resolveRuntimeProfilePin(w, r, scope, strings.TrimSpace(req.RuntimeProfileID), strings.TrimSpace(req.RuntimeProfileVersionID))
	if !ok {
		return
	}
	art, err := s.scripts.Publish(r.Context(), scope, scripts.PublishInput{
		Language:                req.Language,
		Source:                  req.Source,
		Entrypoint:              req.Entrypoint,
		RuntimeProfileID:        pin.ResourceID,
		RuntimeProfileVersionID: pin.VersionID,
		RuntimeProfileDigest:    pin.Digest,
		RuntimeProfile:          pin.Spec,
		InputSchema:             req.InputSchema,
		OutputSchema:            req.OutputSchema,
		TimeoutSeconds:          req.TimeoutSeconds,
		MemoryMiB:               req.MemoryMiB,
		CPUMillis:               req.CPUMillis,
		Processes:               req.Processes,
	})
	if err != nil {
		writeScriptError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, art)
}

func (s *Server) getScriptArtifact(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	if !s.requireScriptPipeline(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("artifactId"))
	if id == "catalog" {
		w.Header().Set("Allow", "GET, HEAD")
		WriteProblem(w, r, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed", "The "+r.Method+" method is not allowed for this path.")
		return
	}
	art, err := s.scripts.Store.Get(r.Context(), scope, id)
	if err != nil {
		writeScriptError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, art)
}

func (s *Server) revokeScriptArtifact(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermScriptRevoke)
	if !ok {
		return
	}
	if !s.requireScriptPipeline(w, r) {
		return
	}
	var req revokeScriptRequest
	if r.ContentLength > 0 {
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	art, err := s.scripts.Revoke(r.Context(), scope, scripts.RevokeInput{
		ArtifactID: strings.TrimSpace(r.PathValue("artifactId")),
		Reason:     req.Reason,
		Now:        s.now(),
	})
	if err != nil {
		writeScriptError(w, r, err)
		return
	}
	if s.workflows != nil {
		_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
			Action:        scripts.AuditRevoke,
			ResourceType:  "script_artifact",
			ResourceID:    art.ID,
			Outcome:       "revoked",
			CorrelationID: RequestIDFromContext(r.Context()),
			Details:       scripts.RevokeAudit(art, scope.ActorID(), strings.TrimSpace(req.Reason)),
		})
	}
	writeJSON(w, http.StatusOK, art)
}

func (s *Server) listWorkflowScriptArtifacts(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok {
		return
	}
	if !s.requireScriptPipeline(w, r) {
		return
	}
	workflowID := strings.TrimSpace(r.PathValue("workflowId"))
	versionID := strings.TrimSpace(r.PathValue("versionId"))
	if _, err := s.workflows.GetVersion(r.Context(), scope, workflowID, versionID); err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	items, err := s.scripts.Store.ListVersionPins(r.Context(), scope, versionID)
	if err != nil {
		writeScriptError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[scripts.VersionPin]{Items: items})
}

func (s *Server) requireScriptPipeline(w http.ResponseWriter, r *http.Request) bool {
	if s.scripts != nil && s.scripts.Store != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Script artifact store is not available.")
	return false
}

func (s *Server) resolveRuntimeProfilePin(w http.ResponseWriter, r *http.Request, scope isolation.Scope, resourceID, versionID string) (opsconfig.Pin, bool) {
	if s.ops == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Operational configuration store is not available.")
		return opsconfig.Pin{}, false
	}
	if strings.TrimSpace(resourceID) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "runtimeProfileId is required.")
		return opsconfig.Pin{}, false
	}
	pins, err := s.ops.Resolve(r.Context(), scope, []opsconfig.Ref{{
		Kind:       opsconfig.KindRuntimeProfile,
		ResourceID: resourceID,
		VersionID:  versionID,
	}})
	if err != nil {
		writeOpsError(w, r, err)
		return opsconfig.Pin{}, false
	}
	if len(pins) != 1 {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "runtimeProfileId must resolve to a published revision.")
		return opsconfig.Pin{}, false
	}
	if err := scripts.ValidateRuntimeProfile("", pins[0].Spec); err != nil {
		writeScriptError(w, r, err)
		return opsconfig.Pin{}, false
	}
	return pins[0], true
}

func (s *Server) publishWorkflowScripts(w http.ResponseWriter, r *http.Request, scope isolation.Scope, yamlDoc, versionID string, pins []opsconfig.Pin) ([]scripts.VersionPin, bool) {
	nodes := scriptNodeSpecs(yamlDoc)
	if len(nodes) == 0 {
		return []scripts.VersionPin{}, true
	}
	if !s.requireScriptPipeline(w, r) {
		return nil, false
	}
	var profiles []scripts.RuntimePin
	for _, pin := range pins {
		if pin.Kind == opsconfig.KindRuntimeProfile {
			profiles = append(profiles, scripts.RuntimePin{
				ResourceID: pin.ResourceID,
				VersionID:  pin.VersionID,
				Digest:     pin.Digest,
				Spec:       pin.Spec,
			})
		}
	}
	out, err := s.scripts.PublishNodes(r.Context(), scope, versionID, nodes, profiles)
	if err != nil {
		if errors.Is(err, scripts.ErrImmutable) {
			existing, listErr := s.scripts.Store.ListVersionPins(r.Context(), scope, versionID)
			if listErr != nil {
				writeScriptError(w, r, listErr)
				return nil, false
			}
			return existing, true
		}
		writeScriptError(w, r, err)
		return nil, false
	}
	return out, true
}

func (s *Server) verifyWorkflowScriptPins(w http.ResponseWriter, r *http.Request, scope isolation.Scope, yamlDoc, versionID string) bool {
	nodes := scriptNodeSpecs(yamlDoc)
	if len(nodes) == 0 {
		return true
	}
	if !s.requireScriptPipeline(w, r) {
		return false
	}
	if err := s.scripts.VerifyNodePins(r.Context(), scope, versionID, nodes); err != nil {
		writeScriptError(w, r, err)
		return false
	}
	return true
}

func (s *Server) authorizeScriptNodes(w http.ResponseWriter, r *http.Request, perms []string, yamlDoc string) bool {
	for _, node := range scriptNodeSpecs(yamlDoc) {
		_ = node
		for _, perm := range scripts.RequiredPermissions() {
			if !authz.Allows(perms, perm) {
				WriteForbidden(w, r)
				return false
			}
		}
	}
	return true
}

func scriptNodeSpecs(yamlDoc string) []scripts.NodeSpec {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return nil
	}
	var out []scripts.NodeSpec
	for _, node := range res.Document.Spec.Nodes {
		if scripts.IsScriptNode(node.Type) {
			out = append(out, scripts.NodeSpec{ID: node.ID, Type: node.Type, With: node.With})
		}
	}
	return out
}

func scriptEngineError(err error) *scripts.EngineError {
	var ee *scripts.EngineError
	if errors.As(err, &ee) {
		return ee
	}
	return nil
}

func writeScriptError(w http.ResponseWriter, r *http.Request, err error) {
	var ee *scripts.EngineError
	if errors.As(err, &ee) && ee != nil {
		status := ee.Status
		if status == 0 {
			status = http.StatusBadRequest
		}
		code := ee.Code
		switch code {
		case scripts.CodeArtifactMutable:
			code = CodeArtifactMutable
		case scripts.CodeArtifactUnscanned:
			code = CodeArtifactUnscanned
		case scripts.CodeArtifactUnsigned:
			code = CodeArtifactUnsigned
		case scripts.CodeArtifactScanFailed:
			code = CodeArtifactScanFailed
		case scripts.CodeArtifactRevoked:
			code = CodeArtifactRevoked
		case scripts.CodeEmergencyStopped:
			code = CodeConflict
		case scripts.CodeEmergencyStopDenied, scripts.CodePolicyDenied:
			WriteForbidden(w, r)
			return
		case scripts.CodePermissionDenied:
			WriteForbidden(w, r)
			return
		case scripts.CodeIsolationDenied:
			code = CodeIsolationDenied
		case scripts.CodeMetadataDenied:
			code = CodeMetadataDenied
		case scripts.CodeEgressDenied:
			code = CodeEgressDenied
		case scripts.CodePackageInstallDenied:
			code = CodePackageInstallDenied
		case scripts.CodeImageDenied:
			code = CodeImageDenied
		case scripts.CodeResourceLimit:
			code = CodeResourceLimit
		case scripts.CodeIndeterminate:
			code = CodeIndeterminate
		case scripts.CodeRetryDenied:
			code = CodeRetryDenied
		case scripts.CodeHandleForbidden:
			code = CodeInvalidRequest
		case scripts.CodeEnvDenied:
			code = CodeInvalidRequest
		case scripts.CodeOutputTooLarge, scripts.CodeInputRejected, scripts.CodeInvalidVerification:
			code = CodeInvalidRequest
		default:
			code = CodeInvalidRequest
		}
		WriteProblem(w, r, status, code, http.StatusText(status), ee.Message)
		return
	}
	switch {
	case errors.Is(err, scripts.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, scripts.ErrMutable):
		WriteProblem(w, r, http.StatusBadRequest, CodeArtifactMutable, "Invalid Request", "Mutable or draft script artifacts cannot be executed.")
	case errors.Is(err, scripts.ErrUnscanned):
		WriteProblem(w, r, http.StatusBadRequest, CodeArtifactUnscanned, "Invalid Request", "Unscanned script artifacts cannot be executed.")
	case errors.Is(err, scripts.ErrUnsigned):
		WriteProblem(w, r, http.StatusBadRequest, CodeArtifactUnsigned, "Invalid Request", "Unsigned script artifacts cannot be executed.")
	case errors.Is(err, scripts.ErrScanFailed):
		WriteProblem(w, r, http.StatusBadRequest, CodeArtifactScanFailed, "Invalid Request", "Script artifacts with a failed scan cannot be executed.")
	case errors.Is(err, scripts.ErrRevoked):
		WriteProblem(w, r, http.StatusConflict, CodeArtifactRevoked, "Conflict", "Revoked script artifacts cannot be executed.")
	case errors.Is(err, scripts.ErrImmutable), errors.Is(err, scripts.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Script artifacts and version pins are immutable.")
	case errors.Is(err, scripts.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Script artifact store is not available.")
	case errors.Is(err, scripts.ErrInvalid), errors.Is(err, scripts.ErrNoScope), errors.Is(err, scripts.ErrSigningKey):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The script package is not valid.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
