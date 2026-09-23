package workspacehttp

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
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

func listRecords(s *core.Server, w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind == "" {
		user, ok := s.RequirePrincipal(w, r)
		if !ok {
			return
		}
		if _, ok := s.RequireScope(w, r, user, authz.PermWorkflowView); !ok {
			return
		}
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "kind is required.")
		return
	}
	listRecordsOfKind(s, w, r, kind, isolation.PermissionFor(kind, "read"))
}

func listJobs(s *core.Server, w http.ResponseWriter, r *http.Request) {
	listRecordsOfKind(s, w, r, isolation.KindJob, isolation.PermissionFor(isolation.KindJob, "read"))
}

func listAuditEvents(s *core.Server, w http.ResponseWriter, r *http.Request) {
	listRecordsOfKind(s, w, r, isolation.KindAudit, isolation.PermissionFor(isolation.KindAudit, "read"))
}

func listRecordsOfKind(s *core.Server, w http.ResponseWriter, r *http.Request, kind, action string) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.RequireScopedStore(w, r) {
		return
	}
	if kind != "" && !isolation.ValidKind(kind) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Unknown isolation kind.")
		return
	}
	if action == "" {
		action = isolation.PermissionFor(kind, "read")
		if kind == "" {
			action = authz.PermWorkflowView
		}
	}
	scope, ok := s.RequireScope(w, r, user, action)
	if !ok {
		return
	}
	items, err := s.Scoped.List(r.Context(), scope, kind)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.ListResponse[isolation.Record]{Items: items})
}

func createRecord(s *core.Server, w http.ResponseWriter, r *http.Request) {
	createRecordOfKind(s, w, r, "")
}

func createJob(s *core.Server, w http.ResponseWriter, r *http.Request) {
	createRecordOfKind(s, w, r, isolation.KindJob)
}

func createRecordOfKind(s *core.Server, w http.ResponseWriter, r *http.Request, forcedKind string) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.RequireScopedStore(w, r) {
		return
	}
	var req createRecordRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) != "" || strings.TrimSpace(req.WorkspaceID) != "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if forcedKind != "" {
		kind = forcedKind
	}
	action := isolation.PermissionFor(kind, "write")
	scope, ok := s.RequireScope(w, r, user, action)
	if !ok {
		return
	}
	rec, err := s.Scoped.Create(r.Context(), scope, isolation.Record{Kind: kind, Name: req.Name, Metadata: req.Metadata})
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, rec)
}

func getRecord(s *core.Server, w http.ResponseWriter, r *http.Request) {
	getRecordOfKind(s, w, r, strings.TrimSpace(r.PathValue("id")), "")
}

func getArtifact(s *core.Server, w http.ResponseWriter, r *http.Request) {
	getRecordOfKind(s, w, r, strings.TrimSpace(r.PathValue("id")), isolation.KindArtifact)
}

func getRecordOfKind(s *core.Server, w http.ResponseWriter, r *http.Request, id, wantKind string) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.RequireScopedStore(w, r) {
		return
	}
	if id == "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "id is required.")
		return
	}
	ws, tenant, _, perms, ok := s.RequireAccess(w, r, user, "")
	if !ok {
		return
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	rec, err := s.Scoped.Get(r.Context(), scope, id)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	if wantKind != "" && rec.Kind != wantKind {
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	needed := isolation.PermissionFor(rec.Kind, "read")
	if needed == "" || !authz.Allows(perms, needed) {
		core.WriteForbidden(w, r)
		return
	}
	core.WriteJSON(w, http.StatusOK, rec)
}

func createRecordLink(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.RequireScopedStore(w, r) {
		return
	}
	parentID := strings.TrimSpace(r.PathValue("id"))
	var req createLinkRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) != "" || strings.TrimSpace(req.WorkspaceID) != "" || strings.TrimSpace(req.ParentID) != "" {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	action := isolation.PermissionFor(req.Kind, "write")
	if action == "" {
		action = authz.PermWorkflowView
	}
	scope, ok := s.RequireScope(w, r, user, action)
	if !ok {
		return
	}
	link, err := s.Scoped.Link(r.Context(), scope, parentID, req.Kind)
	if err != nil {
		writeIsolationError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, link)
}

func useCredential(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.RequireScopedStore(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	scope, ok := s.RequireScope(w, r, user, isolation.PermissionFor(isolation.KindCredential, "use"))
	if !ok {
		return
	}
	if err := s.Scoped.UseCredential(r.Context(), scope, id); err != nil {
		writeIsolationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func subscribeRealtime(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.RequireScopedStore(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	scope, ok := s.RequireScope(w, r, user, isolation.PermissionFor(isolation.KindRealtime, "read"))
	if !ok {
		return
	}
	if err := s.Scoped.Subscribe(r.Context(), scope, id); err != nil {
		writeIsolationError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, subscribeResponse{ChannelID: id, Status: "subscribed"})
}

func getCache(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	scope, ok := s.RequireScope(w, r, user, isolation.PermissionFor(isolation.KindCache, "read"))
	if !ok {
		return
	}
	key := strings.TrimSpace(r.PathValue("key"))
	value, found := s.Cache.Get(scope, key)
	if !found {
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	core.WriteJSON(w, http.StatusOK, cacheValueResponse{Key: key, Value: value})
}

func putCache(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	scope, ok := s.RequireScope(w, r, user, isolation.PermissionFor(isolation.KindCache, "write"))
	if !ok {
		return
	}
	var req cacheValueRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	key := strings.TrimSpace(r.PathValue("key"))
	if err := s.Cache.Set(scope, key, req.Value); err != nil {
		writeIsolationError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, cacheValueResponse{Key: key, Value: req.Value})
}

func writeIsolationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, isolation.ErrNoScope), errors.Is(err, isolation.ErrInvalid):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, isolation.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, isolation.ErrConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "A unique identity already exists.")
	case errors.Is(err, isolation.ErrForbidden):
		core.WriteForbidden(w, r)
	default:
		core.WriteIdentityError(w, r, err)
	}
}
