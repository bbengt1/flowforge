package workflowhttp

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes2(s *core.Server) []rt.Route {
	if s == nil {
		s = &core.Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/schedules/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getScheduleCatalog)),
		rt.R(http.MethodGet, "/api/v1/schedules", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listSchedules)),
		rt.R(http.MethodPost, "/api/v1/schedules", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createSchedule)),
		rt.R(http.MethodPost, "/api/v1/schedules/dispatch", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, dispatchSchedules)),
		rt.R(http.MethodGet, "/api/v1/schedules/{scheduleId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getSchedule)),
		rt.R(http.MethodPatch, "/api/v1/schedules/{scheduleId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, updateSchedule)),
		rt.R(http.MethodPost, "/api/v1/schedules/{scheduleId}/enable", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, enableSchedule)),
		rt.R(http.MethodPost, "/api/v1/schedules/{scheduleId}/disable", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, disableSchedule)),
		rt.R(http.MethodDelete, "/api/v1/schedules/{scheduleId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, deleteSchedule)),
		rt.R(http.MethodPost, "/api/v1/workflows/{workflowId}/executions", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, startWorkflowExecution)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/executions", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkflowExecutions)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/executions/{executionId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getWorkflowExecution)),
		rt.R(http.MethodGet, "/api/v1/executions", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkspaceExecutions)),
		rt.R(http.MethodGet, "/api/v1/executions/{executionId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getWorkspaceExecution)),
		rt.R(http.MethodGet, "/api/v1/executions/{executionId}/steps", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listExecutionSteps)),
		rt.R(http.MethodGet, "/api/v1/executions/{executionId}/steps/{stepId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getExecutionStep)),
		rt.R(http.MethodGet, "/api/v1/executions/{executionId}/steps/{stepId}/logs", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getStepLogs)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/logs", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, uploadStepArtifact)),
		rt.R(http.MethodGet, "/api/v1/executions/{executionId}/artifacts", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listExecutionArtifacts)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/artifacts", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, uploadExecutionArtifact)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/artifacts", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, uploadStepArtifact)),
		rt.R(http.MethodGet, "/api/v1/executions/{executionId}/jobs", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listExecutionJobs)),
		rt.R(http.MethodGet, "/api/v1/executions/{executionId}/audit-events", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listExecutionAuditEvents)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/cancel", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, cancelExecution)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/emergency-stop", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, emergencyStopExecution)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/emergency-stop", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, emergencyStopExecution)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/retry", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, retryExecution)),
		rt.R(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/retry", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, retryExecution)),
		rt.R(http.MethodPost, "/api/v1/jobs/claim", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, claimJob)),
		rt.R(http.MethodPost, "/api/v1/jobs/recover", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, recoverJobs)),
		rt.R(http.MethodPost, "/api/v1/jobs/{jobId}/heartbeat", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, heartbeatJob)),
		rt.R(http.MethodPost, "/api/v1/jobs/{jobId}/release", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, releaseJob)),
		rt.R(http.MethodPost, "/api/v1/jobs/{jobId}/complete", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, completeJob)),
		rt.R(http.MethodPost, "/api/v1/jobs/{jobId}/fail", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, failJob)),
		rt.R(http.MethodGet, "/api/v1/audit-events", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listProductAuditEvents)),
	}
}
