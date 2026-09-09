package httpapi

import (
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
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
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

type downloadGrantResponse struct {
	Download wfstore.DownloadGrant `json:"download"`
}

type retentionPurgeResponse struct {
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

func (s *Server) listExecutionArtifacts(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	items, err := s.workflows.ListArtifacts(r.Context(), scope, wfstore.ArtifactListFilter{
		ExecutionID: strings.TrimSpace(r.PathValue("executionId")),
		StepID:      strings.TrimSpace(r.URL.Query().Get("stepId")),
		Kind:        strings.TrimSpace(r.URL.Query().Get("kind")),
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[wfstore.Artifact]{Items: publicArtifacts(items)})
}

func (s *Server) getProductArtifact(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	art, err := s.authorizeArtifact(r, scope, strings.TrimSpace(r.PathValue("artifactId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, publicArtifact(art))
}

func (s *Server) uploadExecutionArtifact(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowExecute)
	if !ok {
		return
	}
	if !s.keys.Ready() {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Artifact encryption key is not configured.")
		return
	}
	var req uploadArtifactRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt, req.StorageRef, req.StorageRefSnake, req.URL, req.DownloadURL, req.Bucket, req.Key) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied identity, storage locators, or object URLs are not accepted.")
		return
	}
	payload, err := decodeArtifactContent(req)
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Artifact content is missing or not valid base64.")
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
		if kind == artifact.KindLog {
			ct = "text/plain"
		} else if kind == artifact.KindOutput {
			ct = "application/json"
		} else {
			ct = "application/octet-stream"
		}
	}
	if !artifact.AllowedContentType(ct) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Content type is not allowed for artifacts.")
		return
	}
	max := s.artifactMaxBytes
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
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Artifact exceeds the documented size bound.")
		return
	}
	scan := artifact.Scan(kind, class, payload)
	if scan.Reject != "" {
		_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
			Action:       "artifact.upload.rejected",
			ResourceType: "execution",
			ResourceID:   strings.TrimSpace(r.PathValue("executionId")),
			Outcome:      "denied",
			Details:      map[string]any{"reason": "unsafe-content", "kind": kind},
		})
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Unsafe artifact content was rejected before upload.")
		return
	}
	env, digest, err := artifact.Seal(s.keys, scan.Safe)
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	meta, err := json.Marshal(map[string]any{
		"filename":    artifact.SanitizeFilename(req.Filename),
		"contentType": ct,
	})
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Artifact metadata could not be encoded.")
		return
	}
	metaEnv, err := vault.Encrypt(s.keys, meta)
	if err != nil {
		writeVaultError(w, r, err)
		return
	}
	storageRef := newOpaqueRef()
	if err := s.objects.Put(scope.WorkspaceID(), storageRef, env.Ciphertext); err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "Artifact object could not be stored.")
		return
	}
	art, err := s.workflows.CreateArtifact(r.Context(), scope, wfstore.CreateArtifactInput{
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
		_ = s.objects.Delete(scope.WorkspaceID(), storageRef)
		writeWorkflowStoreError(w, r, err)
		return
	}
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:       "artifact.uploaded",
		ResourceType: "artifact",
		ResourceID:   art.ID,
		Outcome:      "ok",
		Details:      map[string]any{"kind": art.Kind, "digest": art.Digest, "redacted": art.Redacted},
	})
	writeJSON(w, http.StatusCreated, publicArtifact(art))
}

func (s *Server) uploadStepArtifact(w http.ResponseWriter, r *http.Request) {
	s.uploadExecutionArtifact(w, r)
}

func (s *Server) getStepLogs(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	stepID := strings.TrimSpace(r.PathValue("stepId"))
	if _, err := s.workflows.GetStep(r.Context(), scope, executionID, stepID); err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	items, err := s.workflows.ListArtifacts(r.Context(), scope, wfstore.ArtifactListFilter{
		ExecutionID: executionID,
		StepID:      stepID,
		Kind:        artifact.KindLog,
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
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
	now := s.now()
	for _, art := range items {
		if !art.ExpiresAt.After(now) && !art.LegalHold {
			continue
		}
		plain, err := s.openArtifact(scope, art)
		if err != nil {
			writeWorkflowStoreError(w, r, err)
			return
		}
		if text != "" {
			text += "\n"
		}
		text += string(plain)
	}
	lines, next, trunc := artifact.BoundLines(text, offset, limit, maxBytes)
	writeJSON(w, http.StatusOK, stepLogsResponse{
		Lines:     lines,
		Offset:    offset,
		Next:      next,
		Truncated: trunc,
		MaxBytes:  maxBytes,
	})
}

func (s *Server) createArtifactDownload(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	if r.Body != nil && r.ContentLength != 0 {
		var req legalHoldRequest
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	art, err := s.authorizeArtifact(r, scope, strings.TrimSpace(r.PathValue("artifactId")))
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	grant, err := s.workflows.CreateDownloadGrant(r.Context(), scope, art.ID, s.now(), s.downloadTTL)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:       "artifact.download.granted",
		ResourceType: "artifact",
		ResourceID:   art.ID,
		Outcome:      "ok",
		Details:      map[string]any{"grantId": grant.ID, "expiresAt": grant.ExpiresAt.UTC().Format(time.RFC3339)},
	})
	writeJSON(w, http.StatusCreated, downloadGrantResponse{Download: grant})
}

func (s *Server) streamArtifactDownload(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermExecutionView)
	if !ok {
		return
	}
	grant, art, err := s.workflows.GetDownloadGrant(r.Context(), scope, strings.TrimSpace(r.PathValue("grantId")), s.now())
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	_ = grant
	s.writeArtifactBytes(w, r, scope, art)
}

func (s *Server) setArtifactLegalHold(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	var req legalHoldRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	hold := true
	if req.Hold != nil {
		hold = *req.Hold
	}
	if hold && strings.TrimSpace(req.Reason) == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Legal hold requires a reason.")
		return
	}
	if _, err := s.authorizeArtifact(r, scope, strings.TrimSpace(r.PathValue("artifactId"))); err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	art, err := s.workflows.SetLegalHold(r.Context(), scope, strings.TrimSpace(r.PathValue("artifactId")), wfstore.LegalHoldInput{
		Hold:   hold,
		Reason: strings.TrimSpace(req.Reason),
	})
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	action := "artifact.legal_hold.released"
	if hold {
		action = "artifact.legal_hold.placed"
	}
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:       action,
		ResourceType: "artifact",
		ResourceID:   art.ID,
		Outcome:      "ok",
		Details:      map[string]any{"legalHold": hold},
	})
	writeJSON(w, http.StatusOK, publicArtifact(art))
}

func (s *Server) purgeRetention(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	now := s.now()
	plan, err := s.workflows.PlanRetentionPurge(r.Context(), scope, now)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	purged := 0
	for _, art := range plan.Purge {
		_ = s.objects.Delete(scope.WorkspaceID(), art.StorageRef)
		if err := s.workflows.DeleteArtifact(r.Context(), scope, art.ID); err != nil {
			writeWorkflowStoreError(w, r, err)
			return
		}
		_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
			Action:       "artifact.retention.purged",
			ResourceType: "artifact",
			ResourceID:   art.ID,
			Outcome:      "ok",
			Details:      map[string]any{"executionId": art.ExecutionID, "kind": art.Kind},
		})
		purged++
	}
	for _, art := range plan.Hold {
		_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
			Action:       "artifact.retention.held",
			ResourceType: "artifact",
			ResourceID:   art.ID,
			Outcome:      "ok",
			Details:      map[string]any{"executionId": art.ExecutionID, "kind": art.Kind},
		})
	}
	execs, audits, err := s.workflows.PurgeExpired(r.Context(), scope, now)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, retentionPurgeResponse{
		Purged:     purged,
		Held:       len(plan.Hold),
		Executions: execs,
		Audits:     audits,
	})
}

func (s *Server) authorizeArtifact(r *http.Request, scope isolation.Scope, artifactID string) (wfstore.Artifact, error) {
	art, err := s.workflows.GetArtifact(r.Context(), scope, artifactID)
	if err != nil {
		return wfstore.Artifact{}, err
	}
	if !art.ExpiresAt.After(s.now()) && !art.LegalHold {
		return wfstore.Artifact{}, wfstore.ErrArtifactExpired
	}
	if _, err := s.workflows.GetExecutionByID(r.Context(), scope, art.ExecutionID); err != nil {
		return wfstore.Artifact{}, err
	}
	return art, nil
}

func (s *Server) openArtifact(scope isolation.Scope, art wfstore.Artifact) ([]byte, error) {
	if !s.keys.Ready() {
		return nil, vault.ErrKeyUnavailable
	}
	ct, err := s.objects.Get(scope.WorkspaceID(), art.StorageRef)
	if err != nil {
		return nil, err
	}
	return artifact.Open(s.keys, vault.Envelope{
		Ciphertext:  ct,
		DEKEnvelope: art.DEKEnvelope,
		KeyRef:      art.KeyReference,
		Version:     art.EncryptionVersion,
	})
}

func (s *Server) writeArtifactBytes(w http.ResponseWriter, r *http.Request, scope isolation.Scope, art wfstore.Artifact) {
	plain, err := s.openArtifact(scope, art)
	if err != nil {
		writeWorkflowStoreError(w, r, err)
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
