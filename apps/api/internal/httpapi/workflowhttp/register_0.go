package workflowhttp

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes1(s *core.Server) []rt.Route {
	if s == nil {
		s = &core.Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/workflows/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getWorkflowCatalog)),
		rt.R(http.MethodPost, "/api/v1/workflows/validate", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, validateWorkflow)),
		rt.R(http.MethodPost, "/api/v1/workflows/normalize", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, normalizeWorkflow)),
		rt.R(http.MethodGet, "/api/v1/workflow-folders", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkflowFolders)),
		rt.R(http.MethodPost, "/api/v1/workflow-folders", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createWorkflowFolder)),
		rt.R(http.MethodGet, "/api/v1/workflow-folders/{folderId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getWorkflowFolder)),
		rt.R(http.MethodPatch, "/api/v1/workflow-folders/{folderId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, updateWorkflowFolder)),
		rt.R(http.MethodDelete, "/api/v1/workflow-folders/{folderId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, deleteWorkflowFolder)),
		rt.R(http.MethodGet, "/api/v1/workflows", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkflows)),
		rt.R(http.MethodPost, "/api/v1/workflows", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, CreateWorkflow)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getWorkflow)),
		rt.R(http.MethodDelete, "/api/v1/workflows/{workflowId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, deleteWorkflow)),
		rt.R(http.MethodPatch, "/api/v1/workflows/{workflowId}/folder", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, patchWorkflowFolder)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/draft", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getWorkflowDraft)),
		rt.R(http.MethodPut, "/api/v1/workflows/{workflowId}/draft", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, putWorkflowDraft)),
		rt.R(http.MethodPost, "/api/v1/workflows/{workflowId}/publish", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, PublishWorkflow)),
		rt.R(http.MethodPost, "/api/v1/workflows/{workflowId}/compare", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, compareWorkflow)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/versions", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkflowVersions)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getWorkflowVersion)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}/export", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, exportWorkflowVersion)),
		rt.R(http.MethodPost, "/api/v1/workflows/{workflowId}/versions/{versionId}/restore", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, restoreWorkflowVersion)),
	}
}
