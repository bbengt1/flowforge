package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

type createRecordRequest struct {
	ID          string         `json:"id"`
	WorkspaceID string         `json:"workspace_id"`
	Kind        string         `json:"kind"`
	Name        string         `json:"name"`
	Metadata    map[string]any `json:"metadata"`
}

type createLinkRequest struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	ParentID    string `json:"parent_id"`
	Kind        string `json:"kind"`
}

type cacheValueResponse struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type cacheValueRequest struct {
	Value string `json:"value"`
}

type subscribeResponse struct {
	ChannelID string `json:"channel_id"`
	Status    string `json:"status"`
}

func (s *Server) listRecords(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind == "" {
		user, ok := s.requirePrincipal(w, r)
		if !ok {
			return
		}
		if _, ok := s.requireScope(w, r, user, authz.PermWorkflowView); !ok {
			return
		}
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "kind is required.")
		return
	}
	s.listRecordsOfKind(w, r, kind, isolation.PermissionFor(kind, "read"))
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	s.listRecordsOfKind(w, r, isolation.KindJob, isolation.PermissionFor(isolation.KindJob, "read"))
}

func (s *Server) listAuditEvents(w http.ResponseWriter, r *http.Request) {
	s.listRecordsOfKind(w, r, isolation.KindAudit, isolation.PermissionFor(isolation.KindAudit, "read"))
}

func (s *Server) listRecordsOfKind(w http.ResponseWriter, r *http.Request, kind, action string) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireScopedStore(w, r) {
		return
	}
	if kind != "" && !isolation.ValidKind(kind) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Unknown isolation kind.")
		return
	}
	if action == "" {
		action = isolation.PermissionFor(kind, "read")
		if kind == "" {
			action = authz.PermWorkflowView
		}
	}
	scope, ok := s.requireScope(w, r, user, action)
	if !ok {
		return
	}
	items, err := s.scoped.List(r.Context(), scope, kind)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[isolation.Record]{Items: items})
}

func (s *Server) createRecord(w http.ResponseWriter, r *http.Request) {
	s.createRecordOfKind(w, r, "")
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	s.createRecordOfKind(w, r, isolation.KindJob)
}

func (s *Server) createRecordOfKind(w http.ResponseWriter, r *http.Request, forcedKind string) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireScopedStore(w, r) {
		return
	}
	var req createRecordRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) != "" || strings.TrimSpace(req.WorkspaceID) != "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if forcedKind != "" {
		kind = forcedKind
	}
	action := isolation.PermissionFor(kind, "write")
	scope, ok := s.requireScope(w, r, user, action)
	if !ok {
		return
	}
	rec, err := s.scoped.Create(r.Context(), scope, isolation.Record{Kind: kind, Name: req.Name, Metadata: req.Metadata})
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, rec)
}

func (s *Server) getRecord(w http.ResponseWriter, r *http.Request) {
	s.getRecordOfKind(w, r, strings.TrimSpace(r.PathValue("id")), "")
}

func (s *Server) getArtifact(w http.ResponseWriter, r *http.Request) {
	s.getRecordOfKind(w, r, strings.TrimSpace(r.PathValue("id")), isolation.KindArtifact)
}

func (s *Server) getRecordOfKind(w http.ResponseWriter, r *http.Request, id, wantKind string) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireScopedStore(w, r) {
		return
	}
	if id == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "id is required.")
		return
	}
	ws, _, _, perms, ok := s.requireAccess(w, r, user, "")
	if !ok {
		return
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	rec, err := s.scoped.Get(r.Context(), scope, id)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	if wantKind != "" && rec.Kind != wantKind {
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	needed := isolation.PermissionFor(rec.Kind, "read")
	if needed == "" || !authz.Allows(perms, needed) {
		WriteForbidden(w, r)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) createRecordLink(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireScopedStore(w, r) {
		return
	}
	parentID := strings.TrimSpace(r.PathValue("id"))
	var req createLinkRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) != "" || strings.TrimSpace(req.WorkspaceID) != "" || strings.TrimSpace(req.ParentID) != "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	action := isolation.PermissionFor(req.Kind, "write")
	if action == "" {
		action = authz.PermWorkflowView
	}
	scope, ok := s.requireScope(w, r, user, action)
	if !ok {
		return
	}
	link, err := s.scoped.Link(r.Context(), scope, parentID, req.Kind)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, link)
}

func (s *Server) useCredential(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireScopedStore(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	scope, ok := s.requireScope(w, r, user, isolation.PermissionFor(isolation.KindCredential, "use"))
	if !ok {
		return
	}
	if err := s.scoped.UseCredential(r.Context(), scope, id); err != nil {
		writeIsolationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) subscribeRealtime(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireScopedStore(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	scope, ok := s.requireScope(w, r, user, isolation.PermissionFor(isolation.KindRealtime, "read"))
	if !ok {
		return
	}
	if err := s.scoped.Subscribe(r.Context(), scope, id); err != nil {
		writeIsolationError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, subscribeResponse{ChannelID: id, Status: "subscribed"})
}

func (s *Server) getCache(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	scope, ok := s.requireScope(w, r, user, isolation.PermissionFor(isolation.KindCache, "read"))
	if !ok {
		return
	}
	key := strings.TrimSpace(r.PathValue("key"))
	value, found := s.cache.Get(scope, key)
	if !found {
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	writeJSON(w, http.StatusOK, cacheValueResponse{Key: key, Value: value})
}

func (s *Server) putCache(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	scope, ok := s.requireScope(w, r, user, isolation.PermissionFor(isolation.KindCache, "write"))
	if !ok {
		return
	}
	var req cacheValueRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	key := strings.TrimSpace(r.PathValue("key"))
	if err := s.cache.Set(scope, key, req.Value); err != nil {
		writeIsolationError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, cacheValueResponse{Key: key, Value: req.Value})
}

func writeIsolationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, isolation.ErrNoScope), errors.Is(err, isolation.ErrInvalid):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, isolation.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, isolation.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "A unique identity already exists.")
	case errors.Is(err, isolation.ErrForbidden):
		WriteForbidden(w, r)
	default:
		writeIdentityError(w, r, err)
	}
}
