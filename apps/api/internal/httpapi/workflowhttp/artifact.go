package workflowhttp

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/vaulthttp"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

type uploadArtifactRequest struct {
	ID                    string `json:"id"`
	WorkspaceID           string `json:"workspace_id"`
	WorkspaceIDAlt        string `json:"workspaceId"`
	Kind                  string `json:"kind"`
	Filename              string `json:"filename"`
	ContentType           string `json:"contentType"`
	ContentClassification string `json:"contentClassification"`
	Content               string `json:"content"`
	ContentBase64         string `json:"contentBase64"`
	StorageRef            string `json:"storageRef"`
	StorageRefSnake       string `json:"storage_ref"`
	URL                   string `json:"url"`
	DownloadURL           string `json:"downloadUrl"`
	Bucket                string `json:"bucket"`
	Key                   string `json:"key"`
}

type legalHoldRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	Hold           *bool  `json:"hold"`
	Reason         string `json:"reason"`
}

type DownloadGrantResponse struct {
	Download wfstore.DownloadGrant `json:"download"`
}

type RetentionPurgeResponse struct {
	Purged     int `json:"purged"`
	Held       int `json:"held"`
	Executions int `json:"executions"`
	Audits     int `json:"audits"`
}

type stepLogsResponse struct {
	Lines     []string `json:"lines"`
	Offset    int      `json:"offset"`
	Next      int      `json:"nextOffset"`
	Truncated bool     `json:"truncated"`
	MaxBytes  int      `json:"maxBytes"`
}

func listExecutionArtifacts(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	items, err := s.Workflows.ListArtifacts(r.Context(), scope, wfstore.ArtifactListFilter{
		ExecutionID: strings.TrimSpace(r.PathValue("executionId")),
		StepID:      strings.TrimSpace(r.URL.Query().Get("stepId")),
		Kind:        strings.TrimSpace(r.URL.Query().Get("kind")),
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.ListResponse[wfstore.Artifact]{Items: publicArtifacts(items)})
}

func getProductArtifact(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	art, err := authorizeArtifact(s, r, scope, strings.TrimSpace(r.PathValue("artifactId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, publicArtifact(art))
}

func uploadExecutionArtifact(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	if !s.Keys.Ready() {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Artifact encryption key is not configured.")
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	exec, err := s.Workflows.GetExecutionByID(r.Context(), scope, executionID)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if !authz.ValidUUID(exec.WorkflowVersionID) {
		WriteWorkflowStoreError(w, r, wfstore.ErrDraftNotRunnable)
		return
	}
	var req uploadArtifactRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt, req.StorageRef, req.StorageRefSnake, req.URL, req.DownloadURL, req.Bucket, req.Key) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied identity, storage locators, or object URLs are not accepted.")
		return
	}
	payload, err := decodeArtifactContent(req)
	if err != nil {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Artifact content is missing or not valid base64.")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		if strings.HasSuffix(r.URL.Path, "/logs") {
			kind = artifact.KindLog
		} else {
			kind = artifact.KindFile
		}
	}
	class := strings.TrimSpace(req.ContentClassification)
	if class == "" {
		class = artifact.ClassInternal
	}
	ct := strings.TrimSpace(req.ContentType)
	if ct == "" {
		switch kind {
		case artifact.KindLog:
			ct = "text/plain"
		case artifact.KindOutput:
			ct = "application/json"
		default:
			ct = "application/octet-stream"
		}
	}
	if !artifact.AllowedContentType(ct) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Content type is not allowed for artifacts.")
		return
	}
	max := s.ArtifactMaxBytes
	if max <= 0 {
		max = artifact.DefaultMaxBytes
	}
	if kind == artifact.KindLog && max > artifact.DefaultLogMaxBytes {
		max = artifact.DefaultLogMaxBytes
	}
	if kind == artifact.KindOutput && max > artifact.DefaultOutputBytes {
		max = artifact.DefaultOutputBytes
	}
	if len(payload) > max {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Artifact exceeds the documented size bound.")
		return
	}
	scan := artifact.Scan(kind, class, payload)
	if scan.Reject != "" {
		s.EmitAlert(r, scope, opsalert.Signal{
			Kind:         opsalert.KindRedaction,
			Action:       "artifact.upload",
			ResourceType: "execution",
			ResourceID:   executionID,
			Code:         core.CodeInvalidRequest,
			Details:      map[string]any{"reason": "unsafe-content"},
		})
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Unsafe artifact content was rejected before upload.")
		return
	}
	env, digest, err := artifact.Seal(s.Keys, scan.Safe)
	if err != nil {
		vaulthttp.WriteVaultError(w, r, err)
		return
	}
	meta, err := json.Marshal(map[string]any{
		"filename":    artifact.SanitizeFilename(req.Filename),
		"contentType": ct,
	})
	if err != nil {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Artifact metadata could not be encoded.")
		return
	}
	metaEnv, err := vault.Encrypt(s.Keys, meta)
	if err != nil {
		vaulthttp.WriteVaultError(w, r, err)
		return
	}
	storageRef := newOpaqueRef()
	if err := s.Objects.Put(scope.TenantID(), scope.WorkspaceID(), storageRef, env.Ciphertext); err != nil {
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "Artifact object could not be stored.")
		return
	}
	art, err := s.Workflows.CreateArtifact(r.Context(), scope, wfstore.CreateArtifactInput{
		ExecutionID:           strings.TrimSpace(r.PathValue("executionId")),
		StepID:                strings.TrimSpace(r.PathValue("stepId")),
		Kind:                  kind,
		Filename:              artifact.SanitizeFilename(req.Filename),
		ContentType:           ct,
		ContentClassification: class,
		Digest:                digest,
		SizeBytes:             int64(len(scan.Safe)),
		Redacted:              scan.Redacted,
		StorageRef:            storageRef,
		MetadataCiphertext:    metaEnv.Ciphertext,
		DEKEnvelope:           env.DEKEnvelope,
		KeyReference:          env.KeyRef,
		EncryptionVersion:     env.Version,
	})
	if err != nil {
		_ = s.Objects.Delete(scope.TenantID(), scope.WorkspaceID(), storageRef)
		WriteWorkflowStoreError(w, r, err)
		return
	}
	_, _ = s.Workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:       "artifact.uploaded",
		ResourceType: "artifact",
		ResourceID:   art.ID,
		Outcome:      "ok",
		Details:      map[string]any{"kind": art.Kind, "digest": art.Digest, "redacted": art.Redacted},
	})
	core.WriteJSON(w, http.StatusCreated, publicArtifact(art))
}

func uploadStepArtifact(s *core.Server, w http.ResponseWriter, r *http.Request) {
	uploadExecutionArtifact(s, w, r)
}

func getStepLogs(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	stepID := strings.TrimSpace(r.PathValue("stepId"))
	if _, err := s.Workflows.GetStep(r.Context(), scope, executionID, stepID); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	items, err := s.Workflows.ListArtifacts(r.Context(), scope, wfstore.ArtifactListFilter{
		ExecutionID: executionID,
		StepID:      stepID,
		Kind:        artifact.KindLog,
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	offset, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("offset")))
	limit, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("limit")))
	maxBytes, _ := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("maxBytes")))
	if maxBytes <= 0 {
		maxBytes = artifact.DefaultOutputBytes
	}
	if maxBytes > artifact.DefaultLogMaxBytes {
		maxBytes = artifact.DefaultLogMaxBytes
	}
	var text string
	now := Now(s)
	for _, art := range items {
		if !art.ExpiresAt.After(now) && !art.LegalHold {
			continue
		}
		plain, err := openArtifact(s, scope, art)
		if err != nil {
			WriteWorkflowStoreError(w, r, err)
			return
		}
		if text != "" {
			text += "\n"
		}
		text += string(plain)
	}
	lines, next, trunc := artifact.BoundLines(text, offset, limit, maxBytes)
	core.WriteJSON(w, http.StatusOK, stepLogsResponse{
		Lines:     lines,
		Offset:    offset,
		Next:      next,
		Truncated: trunc,
		MaxBytes:  maxBytes,
	})
}

func createArtifactDownload(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	if r.Body != nil && r.ContentLength != 0 {
		var req legalHoldRequest
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	art, err := authorizeArtifact(s, r, scope, strings.TrimSpace(r.PathValue("artifactId")))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	grant, err := s.Workflows.CreateDownloadGrant(r.Context(), scope, art.ID, Now(s), s.DownloadTTL)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	_, _ = s.Workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:       "artifact.download.granted",
		ResourceType: "artifact",
		ResourceID:   art.ID,
		Outcome:      "ok",
		Details:      map[string]any{"grantId": grant.ID, "expiresAt": grant.ExpiresAt.UTC().Format(time.RFC3339)},
	})
	core.WriteJSON(w, http.StatusCreated, DownloadGrantResponse{Download: grant})
}

func streamArtifactDownload(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	grant, art, err := s.Workflows.GetDownloadGrant(r.Context(), scope, strings.TrimSpace(r.PathValue("grantId")), Now(s))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	_ = grant
	writeArtifactBytes(s, w, r, scope, art)
}

func setArtifactLegalHold(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	var req legalHoldRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	hold := true
	if req.Hold != nil {
		hold = *req.Hold
	}
	if hold && strings.TrimSpace(req.Reason) == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Legal hold requires a reason.")
		return
	}
	if _, err := authorizeArtifact(s, r, scope, strings.TrimSpace(r.PathValue("artifactId"))); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	art, err := s.Workflows.SetLegalHold(r.Context(), scope, strings.TrimSpace(r.PathValue("artifactId")), wfstore.LegalHoldInput{
		Hold:   hold,
		Reason: strings.TrimSpace(req.Reason),
	})
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	action := "artifact.legal_hold.released"
	if hold {
		action = "artifact.legal_hold.placed"
	}
	_, _ = s.Workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:       action,
		ResourceType: "artifact",
		ResourceID:   art.ID,
		Outcome:      "ok",
		Details:      map[string]any{"legalHold": hold},
	})
	core.WriteJSON(w, http.StatusOK, publicArtifact(art))
}

func purgeRetention(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	out, err := purgeWorkspace(s, r.Context(), scope, Now(s))
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

func purgeWorkspace(s *core.Server, ctx context.Context, scope isolation.Scope, now time.Time) (RetentionPurgeResponse, error) {
	if s.Workflows == nil {
		return RetentionPurgeResponse{}, wfstore.ErrStoreUnavailable
	}
	plan, err := s.Workflows.PlanRetentionPurge(ctx, scope, now)
	if err != nil {
		return RetentionPurgeResponse{}, err
	}
	purged := 0
	for _, art := range plan.Purge {
		if s.Objects != nil {
			_ = s.Objects.Delete(scope.TenantID(), scope.WorkspaceID(), art.StorageRef)
		}
		if err := s.Workflows.DeleteArtifact(ctx, scope, art.ID); err != nil {
			return RetentionPurgeResponse{}, err
		}
		_, _ = s.Workflows.WriteAudit(ctx, scope, wfstore.AuditWrite{
			Action:       "artifact.retention.purged",
			ResourceType: "artifact",
			ResourceID:   art.ID,
			Outcome:      "ok",
			Details:      map[string]any{"executionId": art.ExecutionID, "kind": art.Kind},
		})
		purged++
	}
	for _, art := range plan.Hold {
		_, _ = s.Workflows.WriteAudit(ctx, scope, wfstore.AuditWrite{
			Action:       "artifact.retention.held",
			ResourceType: "artifact",
			ResourceID:   art.ID,
			Outcome:      "ok",
			Details:      map[string]any{"executionId": art.ExecutionID, "kind": art.Kind},
		})
	}
	execs, audits, err := s.Workflows.PurgeExpired(ctx, scope, now)
	if err != nil {
		return RetentionPurgeResponse{}, err
	}
	return RetentionPurgeResponse{
		Purged:     purged,
		Held:       len(plan.Hold),
		Executions: execs,
		Audits:     audits,
	}, nil
}

func authorizeArtifact(s *core.Server, r *http.Request, scope isolation.Scope, artifactID string) (wfstore.Artifact, error) {
	art, err := s.Workflows.GetArtifact(r.Context(), scope, artifactID)
	if err != nil {
		return wfstore.Artifact{}, err
	}
	if !art.ExpiresAt.After(Now(s)) && !art.LegalHold {
		return wfstore.Artifact{}, wfstore.ErrArtifactExpired
	}
	if _, err := s.Workflows.GetExecutionByID(r.Context(), scope, art.ExecutionID); err != nil {
		return wfstore.Artifact{}, err
	}
	return art, nil
}

func openArtifact(s *core.Server, scope isolation.Scope, art wfstore.Artifact) ([]byte, error) {
	if !s.Keys.Ready() {
		return nil, vault.ErrKeyUnavailable
	}
	ct, err := s.Objects.Get(scope.TenantID(), scope.WorkspaceID(), art.StorageRef)
	if err != nil {
		return nil, err
	}
	return artifact.Open(s.Keys, vault.Envelope{
		Ciphertext:  ct,
		DEKEnvelope: art.DEKEnvelope,
		KeyRef:      art.KeyReference,
		Version:     art.EncryptionVersion,
	})
}

func writeArtifactBytes(s *core.Server, w http.ResponseWriter, r *http.Request, scope isolation.Scope, art wfstore.Artifact) {
	plain, err := openArtifact(s, scope, art)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", art.ContentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(art.Filename, `"`, "")+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(plain)
}

func decodeArtifactContent(req uploadArtifactRequest) ([]byte, error) {
	if strings.TrimSpace(req.ContentBase64) != "" {
		return base64.StdEncoding.DecodeString(strings.TrimSpace(req.ContentBase64))
	}
	if req.Content != "" {
		return []byte(req.Content), nil
	}
	return nil, wfstore.ErrInvalid
}

func publicArtifact(a wfstore.Artifact) wfstore.Artifact {
	a.StorageRef = ""
	a.DEKEnvelope = nil
	a.KeyReference = ""
	a.EncryptionVersion = 0
	a.MetadataCiphertext = nil
	return a
}

func publicArtifacts(items []wfstore.Artifact) []wfstore.Artifact {
	if items == nil {
		return []wfstore.Artifact{}
	}
	out := make([]wfstore.Artifact, len(items))
	for i, item := range items {
		out[i] = publicArtifact(item)
	}
	return out
}

func newOpaqueRef() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
