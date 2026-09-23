package httpapi

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
)

// AuthClass is the route-table classification published in OpenAPI.
// Handlers still enforce the real door. This label does not grant access.
const (
	// AuthPublic is reachable without a session: probes, first-run
	// bootstrap, login/OIDC, machine-token exchange, and signed webhook
	// ingress. Bootstrap fail-closes once install is complete.
	AuthPublic AuthClass = "public"
	// AuthEmbed is an embed or portal surface that answers without a
	// browser session (catalog, JWKS, exchange, portal adapter).
	// Mint and key rotation stay AuthAuthenticated.
	AuthEmbed AuthClass = "embed"
	// AuthAuthenticated requires a principal (session, worker credential,
	// SCIM bearer, or platform ops). It is not an anonymous door.
	AuthAuthenticated AuthClass = "authenticated"
)

// AuthClass classifies who may call a route.
type AuthClass string

// ProxyClass says whether the Next identity proxy may forward the route.
const (
	// ProxyBrowser is on the generated identity-proxy allowlist.
	ProxyBrowser ProxyClass = "browser"
	// ProxyNone stays off the browser allowlist: probes, platform scrape,
	// webhook ingress, worker job protocol, SCIM, machine-principal admin,
	// account lockout, and worker upload / retention maintenance.
	ProxyNone ProxyClass = "none"
)

// ProxyClass is the identity-proxy audience for one method.
type ProxyClass string

// Route is one mux registration. Routes is the source of truth for the
// mux, the generated OpenAPI document, and the identity-proxy allowlist.
type Route struct {
	Method  string
	Pattern string
	Auth    AuthClass
	Proxy   ProxyClass
	// SpecRef is an OpenAPI path-item $ref shared by ops-config collections.
	SpecRef string
	Handler http.HandlerFunc
}

// OpenAPIPath is the path key under servers.url /api/v1.
// Routes outside that prefix (SCIM) keep their origin path.
func (r Route) OpenAPIPath() string {
	const prefix = "/api/v1"
	if r.Pattern == prefix {
		return "/"
	}
	if strings.HasPrefix(r.Pattern, prefix+"/") {
		return strings.TrimPrefix(r.Pattern, prefix)
	}
	return r.Pattern
}

// Routes returns every control-plane route in mux registration order.
// Passing nil is safe: handlers are not invoked.
//
//go:generate go run ../../cmd/genroutes
func Routes(s *Server) []Route {
	if s == nil {
		s = &Server{}
	}
	out := []Route{
		rt(http.MethodGet, "/api/v1/health", AuthPublic, ProxyNone, s.health),
		rt(http.MethodGet, "/api/v1/readiness", AuthPublic, ProxyNone, s.readiness),
		rt(http.MethodGet, "/api/v1/bootstrap", AuthPublic, ProxyBrowser, s.getBootstrap),
		rt(http.MethodPost, "/api/v1/bootstrap/persistence", AuthPublic, ProxyBrowser, s.postBootstrapPersistence),
		rt(http.MethodPost, "/api/v1/bootstrap/admins", AuthPublic, ProxyBrowser, s.postBootstrapAdmins),
		rt(http.MethodPost, "/api/v1/bootstrap/public-url", AuthPublic, ProxyBrowser, s.postBootstrapPublicURL),
		rt(http.MethodPost, "/api/v1/bootstrap/tls", AuthPublic, ProxyBrowser, s.postBootstrapTLS),
		rt(http.MethodGet, "/api/v1/metrics", AuthAuthenticated, ProxyNone, s.metrics),
		rt(http.MethodGet, "/api/v1/openapi.yaml", AuthAuthenticated, ProxyNone, s.openapiYAML),
		rt(http.MethodGet, "/api/v1/openapi.json", AuthAuthenticated, ProxyNone, s.openapiJSON),
		rt(http.MethodGet, "/api/v1/swagger", AuthAuthenticated, ProxyNone, s.swagger),
		rt(http.MethodGet, "/api/v1/permission-matrix", AuthAuthenticated, ProxyBrowser, s.getPermissionMatrix),
		rt(http.MethodGet, "/api/v1/roles", AuthAuthenticated, ProxyBrowser, s.getRoles),
		rt(http.MethodGet, "/api/v1/permissions", AuthAuthenticated, ProxyBrowser, s.getPermissions),
		rt(http.MethodPost, "/api/v1/tenants", AuthAuthenticated, ProxyBrowser, s.createTenant),
		rt(http.MethodGet, "/api/v1/workspaces", AuthAuthenticated, ProxyBrowser, s.listWorkspaces),
		rt(http.MethodPost, "/api/v1/workspaces", AuthAuthenticated, ProxyBrowser, s.createWorkspace),
		rt(http.MethodGet, "/api/v1/workspace", AuthAuthenticated, ProxyBrowser, s.getCurrentWorkspace),
		rt(http.MethodDelete, "/api/v1/workspace", AuthAuthenticated, ProxyBrowser, s.deleteWorkspace),
		rt(http.MethodGet, "/api/v1/workspace/members", AuthAuthenticated, ProxyBrowser, s.listMembers),
		rt(http.MethodPut, "/api/v1/workspace/members", AuthAuthenticated, ProxyBrowser, s.putMember),
		rt(http.MethodDelete, "/api/v1/workspace/members/{userID}", AuthAuthenticated, ProxyBrowser, s.deleteMember),
		rt(http.MethodGet, "/api/v1/workspace/records", AuthAuthenticated, ProxyBrowser, s.listRecords),
		rt(http.MethodPost, "/api/v1/workspace/records", AuthAuthenticated, ProxyBrowser, s.createRecord),
		rt(http.MethodGet, "/api/v1/workspace/records/{id}", AuthAuthenticated, ProxyBrowser, s.getRecord),
		rt(http.MethodPost, "/api/v1/workspace/records/{id}/links", AuthAuthenticated, ProxyBrowser, s.createRecordLink),
		rt(http.MethodPost, "/api/v1/workspace/credentials/{id}/use", AuthAuthenticated, ProxyBrowser, s.useCredential),
		rt(http.MethodGet, "/api/v1/workspace/artifacts/{id}", AuthAuthenticated, ProxyBrowser, s.getArtifact),
		rt(http.MethodGet, "/api/v1/workspace/jobs", AuthAuthenticated, ProxyBrowser, s.listJobs),
		rt(http.MethodPost, "/api/v1/workspace/jobs", AuthAuthenticated, ProxyBrowser, s.createJob),
		rt(http.MethodGet, "/api/v1/workspace/cache/{key}", AuthAuthenticated, ProxyBrowser, s.getCache),
		rt(http.MethodPut, "/api/v1/workspace/cache/{key}", AuthAuthenticated, ProxyBrowser, s.putCache),
		rt(http.MethodPost, "/api/v1/workspace/realtime/channels/{id}/subscribe", AuthAuthenticated, ProxyBrowser, s.subscribeRealtime),
		rt(http.MethodGet, "/api/v1/workspace/audit-events", AuthAuthenticated, ProxyBrowser, s.listAuditEvents),
		rt(http.MethodPost, "/api/v1/login", AuthPublic, ProxyBrowser, s.postLogin),
		rt(http.MethodPost, "/api/v1/oidc/start", AuthPublic, ProxyBrowser, s.postOIDCStart),
		rt(http.MethodPost, "/api/v1/oidc/callback", AuthPublic, ProxyBrowser, s.postOIDCCallback),
		rt(http.MethodGet, "/api/v1/users/{userID}/lockout", AuthAuthenticated, ProxyNone, s.getAccountLockout),
		rt(http.MethodPost, "/api/v1/users/{userID}/unlock", AuthAuthenticated, ProxyNone, s.postAccountUnlock),
		rt(http.MethodGet, "/scim/v2/ServiceProviderConfig", AuthAuthenticated, ProxyNone, s.getSCIMServiceProviderConfig),
		rt(http.MethodGet, "/scim/v2/Schemas", AuthAuthenticated, ProxyNone, s.getSCIMSchemas),
		rt(http.MethodGet, "/scim/v2/ResourceTypes", AuthAuthenticated, ProxyNone, s.getSCIMResourceTypes),
		rt(http.MethodGet, "/scim/v2/Users", AuthAuthenticated, ProxyNone, s.listSCIMUsers),
		rt(http.MethodPost, "/scim/v2/Users", AuthAuthenticated, ProxyNone, s.postSCIMUser),
		rt(http.MethodGet, "/scim/v2/Users/{id}", AuthAuthenticated, ProxyNone, s.getSCIMUser),
		rt(http.MethodPut, "/scim/v2/Users/{id}", AuthAuthenticated, ProxyNone, s.putSCIMUser),
		rt(http.MethodPatch, "/scim/v2/Users/{id}", AuthAuthenticated, ProxyNone, s.patchSCIMUser),
		rt(http.MethodDelete, "/scim/v2/Users/{id}", AuthAuthenticated, ProxyNone, s.deleteSCIMUser),
		rt(http.MethodGet, "/scim/v2/Groups", AuthAuthenticated, ProxyNone, s.listSCIMGroups),
		rt(http.MethodPost, "/scim/v2/Groups", AuthAuthenticated, ProxyNone, s.postSCIMGroup),
		rt(http.MethodGet, "/scim/v2/Groups/{id}", AuthAuthenticated, ProxyNone, s.getSCIMGroup),
		rt(http.MethodPut, "/scim/v2/Groups/{id}", AuthAuthenticated, ProxyNone, s.putSCIMGroup),
		rt(http.MethodPatch, "/scim/v2/Groups/{id}", AuthAuthenticated, ProxyNone, s.patchSCIMGroup),
		rt(http.MethodDelete, "/scim/v2/Groups/{id}", AuthAuthenticated, ProxyNone, s.deleteSCIMGroup),
		rt(http.MethodPost, "/api/v1/machine/token", AuthPublic, ProxyNone, s.postMachineToken),
		rt(http.MethodGet, "/api/v1/machine/principals", AuthAuthenticated, ProxyNone, s.listMachinePrincipals),
		rt(http.MethodPost, "/api/v1/machine/principals", AuthAuthenticated, ProxyNone, s.postMachinePrincipal),
		rt(http.MethodGet, "/api/v1/machine/principals/{id}", AuthAuthenticated, ProxyNone, s.getMachinePrincipal),
		rt(http.MethodPost, "/api/v1/machine/principals/{id}/rotate", AuthAuthenticated, ProxyNone, s.rotateMachinePrincipal),
		rt(http.MethodPost, "/api/v1/machine/principals/{id}/revoke", AuthAuthenticated, ProxyNone, s.revokeMachinePrincipal),
		rt(http.MethodPost, "/api/v1/session", AuthAuthenticated, ProxyBrowser, s.createSession),
		rt(http.MethodGet, "/api/v1/session", AuthAuthenticated, ProxyBrowser, s.getSession),
		rt(http.MethodPost, "/api/v1/session/refresh", AuthAuthenticated, ProxyBrowser, s.refreshSession),
		rt(http.MethodPost, "/api/v1/session/logout", AuthAuthenticated, ProxyBrowser, s.logoutSession),
		rt(http.MethodPost, "/api/v1/session/password", AuthAuthenticated, ProxyBrowser, s.postSessionPassword),
		rt(http.MethodGet, "/api/v1/session/mfa", AuthAuthenticated, ProxyBrowser, s.getSessionMFA),
		rt(http.MethodPost, "/api/v1/session/mfa/enroll", AuthAuthenticated, ProxyBrowser, s.postSessionMFAEnroll),
		rt(http.MethodPost, "/api/v1/session/mfa/verify", AuthAuthenticated, ProxyBrowser, s.postSessionMFAVerify),
		rt(http.MethodGet, "/api/v1/session/audit-events", AuthAuthenticated, ProxyBrowser, s.listSessionAudit),
		rt(http.MethodGet, "/api/v1/embed/catalog", AuthEmbed, ProxyBrowser, s.getEmbedCatalog),
		rt(http.MethodGet, "/api/v1/embed/jwks", AuthEmbed, ProxyBrowser, s.getEmbedJWKS),
		rt(http.MethodPost, "/api/v1/embed/assertions", AuthAuthenticated, ProxyBrowser, s.mintEmbedAssertion),
		rt(http.MethodPost, "/api/v1/embed/exchange", AuthEmbed, ProxyBrowser, s.exchangeEmbedAssertion),
		rt(http.MethodPost, "/api/v1/embed/keys/rotate", AuthAuthenticated, ProxyBrowser, s.rotateEmbedKeys),
		rt(http.MethodGet, "/api/v1/portal/adapter", AuthEmbed, ProxyBrowser, s.getPortalAdapter),
		rt(http.MethodPost, "/api/v1/portal/adapter/assertions", AuthAuthenticated, ProxyBrowser, s.mintPortalAssertion),
		rt(http.MethodGet, "/api/v1/workflows/catalog", AuthAuthenticated, ProxyBrowser, s.getWorkflowCatalog),
		rt(http.MethodPost, "/api/v1/workflows/validate", AuthAuthenticated, ProxyBrowser, s.validateWorkflow),
		rt(http.MethodPost, "/api/v1/workflows/normalize", AuthAuthenticated, ProxyBrowser, s.normalizeWorkflow),
		rt(http.MethodGet, "/api/v1/workflow-folders", AuthAuthenticated, ProxyBrowser, s.listWorkflowFolders),
		rt(http.MethodPost, "/api/v1/workflow-folders", AuthAuthenticated, ProxyBrowser, s.createWorkflowFolder),
		rt(http.MethodGet, "/api/v1/workflow-folders/{folderId}", AuthAuthenticated, ProxyBrowser, s.getWorkflowFolder),
		rt(http.MethodPatch, "/api/v1/workflow-folders/{folderId}", AuthAuthenticated, ProxyBrowser, s.updateWorkflowFolder),
		rt(http.MethodDelete, "/api/v1/workflow-folders/{folderId}", AuthAuthenticated, ProxyBrowser, s.deleteWorkflowFolder),
		rt(http.MethodGet, "/api/v1/workflows", AuthAuthenticated, ProxyBrowser, s.listWorkflows),
		rt(http.MethodPost, "/api/v1/workflows", AuthAuthenticated, ProxyBrowser, s.createWorkflow),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}", AuthAuthenticated, ProxyBrowser, s.getWorkflow),
		rt(http.MethodPatch, "/api/v1/workflows/{workflowId}/folder", AuthAuthenticated, ProxyBrowser, s.patchWorkflowFolder),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/draft", AuthAuthenticated, ProxyBrowser, s.getWorkflowDraft),
		rt(http.MethodPut, "/api/v1/workflows/{workflowId}/draft", AuthAuthenticated, ProxyBrowser, s.putWorkflowDraft),
		rt(http.MethodPost, "/api/v1/workflows/{workflowId}/publish", AuthAuthenticated, ProxyBrowser, s.publishWorkflow),
		rt(http.MethodPost, "/api/v1/workflows/{workflowId}/compare", AuthAuthenticated, ProxyBrowser, s.compareWorkflow),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/versions", AuthAuthenticated, ProxyBrowser, s.listWorkflowVersions),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}", AuthAuthenticated, ProxyBrowser, s.getWorkflowVersion),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}/export", AuthAuthenticated, ProxyBrowser, s.exportWorkflowVersion),
		rt(http.MethodPost, "/api/v1/workflows/{workflowId}/versions/{versionId}/restore", AuthAuthenticated, ProxyBrowser, s.restoreWorkflowVersion),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/triggers", AuthAuthenticated, ProxyBrowser, s.listWorkflowTriggers),
		rt(http.MethodPost, "/api/v1/workflows/{workflowId}/triggers", AuthAuthenticated, ProxyBrowser, s.createWorkflowTrigger),
		rt(http.MethodGet, "/api/v1/triggers/{triggerId}", AuthAuthenticated, ProxyBrowser, s.getTrigger),
		rt(http.MethodPatch, "/api/v1/triggers/{triggerId}", AuthAuthenticated, ProxyBrowser, s.updateTrigger),
		rt(http.MethodPost, "/api/v1/triggers/{triggerId}/rotate", AuthAuthenticated, ProxyBrowser, s.rotateTrigger),
		rt(http.MethodPost, "/api/v1/triggers/{triggerId}/disable", AuthAuthenticated, ProxyBrowser, s.disableTrigger),
		rt(http.MethodPost, "/api/v1/triggers/{triggerId}/enable", AuthAuthenticated, ProxyBrowser, s.enableTrigger),
		rt(http.MethodDelete, "/api/v1/triggers/{triggerId}", AuthAuthenticated, ProxyBrowser, s.deleteTrigger),
		rt(http.MethodPost, "/api/v1/hooks/{publicId}", AuthPublic, ProxyNone, s.deliverWebhook),
		rt(http.MethodGet, "/api/v1/schedules/catalog", AuthAuthenticated, ProxyBrowser, s.getScheduleCatalog),
		rt(http.MethodGet, "/api/v1/schedules", AuthAuthenticated, ProxyBrowser, s.listSchedules),
		rt(http.MethodPost, "/api/v1/schedules", AuthAuthenticated, ProxyBrowser, s.createSchedule),
		rt(http.MethodPost, "/api/v1/schedules/dispatch", AuthAuthenticated, ProxyBrowser, s.dispatchSchedules),
		rt(http.MethodGet, "/api/v1/schedules/{scheduleId}", AuthAuthenticated, ProxyBrowser, s.getSchedule),
		rt(http.MethodPatch, "/api/v1/schedules/{scheduleId}", AuthAuthenticated, ProxyBrowser, s.updateSchedule),
		rt(http.MethodPost, "/api/v1/schedules/{scheduleId}/enable", AuthAuthenticated, ProxyBrowser, s.enableSchedule),
		rt(http.MethodPost, "/api/v1/schedules/{scheduleId}/disable", AuthAuthenticated, ProxyBrowser, s.disableSchedule),
		rt(http.MethodDelete, "/api/v1/schedules/{scheduleId}", AuthAuthenticated, ProxyBrowser, s.deleteSchedule),
		rt(http.MethodPost, "/api/v1/workflows/{workflowId}/executions", AuthAuthenticated, ProxyBrowser, s.startWorkflowExecution),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/executions", AuthAuthenticated, ProxyBrowser, s.listWorkflowExecutions),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/executions/{executionId}", AuthAuthenticated, ProxyBrowser, s.getWorkflowExecution),
		rt(http.MethodGet, "/api/v1/executions", AuthAuthenticated, ProxyBrowser, s.listWorkspaceExecutions),
		rt(http.MethodGet, "/api/v1/executions/{executionId}", AuthAuthenticated, ProxyBrowser, s.getWorkspaceExecution),
		rt(http.MethodGet, "/api/v1/executions/{executionId}/steps", AuthAuthenticated, ProxyBrowser, s.listExecutionSteps),
		rt(http.MethodGet, "/api/v1/executions/{executionId}/steps/{stepId}", AuthAuthenticated, ProxyBrowser, s.getExecutionStep),
		rt(http.MethodGet, "/api/v1/executions/{executionId}/steps/{stepId}/logs", AuthAuthenticated, ProxyBrowser, s.getStepLogs),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/logs", AuthAuthenticated, ProxyNone, s.uploadStepArtifact),
		rt(http.MethodGet, "/api/v1/executions/{executionId}/artifacts", AuthAuthenticated, ProxyBrowser, s.listExecutionArtifacts),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/artifacts", AuthAuthenticated, ProxyNone, s.uploadExecutionArtifact),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/artifacts", AuthAuthenticated, ProxyNone, s.uploadStepArtifact),
		rt(http.MethodGet, "/api/v1/executions/{executionId}/jobs", AuthAuthenticated, ProxyBrowser, s.listExecutionJobs),
		rt(http.MethodGet, "/api/v1/executions/{executionId}/audit-events", AuthAuthenticated, ProxyBrowser, s.listExecutionAuditEvents),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/cancel", AuthAuthenticated, ProxyBrowser, s.cancelExecution),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/emergency-stop", AuthAuthenticated, ProxyBrowser, s.emergencyStopExecution),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/emergency-stop", AuthAuthenticated, ProxyBrowser, s.emergencyStopExecution),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/retry", AuthAuthenticated, ProxyBrowser, s.retryExecution),
		rt(http.MethodPost, "/api/v1/executions/{executionId}/steps/{stepId}/retry", AuthAuthenticated, ProxyBrowser, s.retryExecution),
		rt(http.MethodPost, "/api/v1/jobs/claim", AuthAuthenticated, ProxyNone, s.claimJob),
		rt(http.MethodPost, "/api/v1/jobs/recover", AuthAuthenticated, ProxyNone, s.recoverJobs),
		rt(http.MethodPost, "/api/v1/jobs/{jobId}/heartbeat", AuthAuthenticated, ProxyNone, s.heartbeatJob),
		rt(http.MethodPost, "/api/v1/jobs/{jobId}/release", AuthAuthenticated, ProxyNone, s.releaseJob),
		rt(http.MethodPost, "/api/v1/jobs/{jobId}/complete", AuthAuthenticated, ProxyNone, s.completeJob),
		rt(http.MethodPost, "/api/v1/jobs/{jobId}/fail", AuthAuthenticated, ProxyNone, s.failJob),
		rt(http.MethodGet, "/api/v1/audit-events", AuthAuthenticated, ProxyBrowser, s.listProductAuditEvents),
		rt(http.MethodGet, "/api/v1/alerts", AuthAuthenticated, ProxyBrowser, s.listOperationalAlerts),
		rt(http.MethodGet, "/api/v1/alerts/{alertId}", AuthAuthenticated, ProxyBrowser, s.getOperationalAlert),
		rt(http.MethodPost, "/api/v1/alerts/{alertId}/ack", AuthAuthenticated, ProxyBrowser, s.ackOperationalAlert),
		rt(http.MethodGet, "/api/v1/artifacts/{artifactId}", AuthAuthenticated, ProxyBrowser, s.getProductArtifact),
		rt(http.MethodPost, "/api/v1/artifacts/{artifactId}/downloads", AuthAuthenticated, ProxyBrowser, s.createArtifactDownload),
		rt(http.MethodGet, "/api/v1/artifact-downloads/{grantId}", AuthAuthenticated, ProxyBrowser, s.streamArtifactDownload),
		rt(http.MethodPost, "/api/v1/artifacts/{artifactId}/legal-hold", AuthAuthenticated, ProxyNone, s.setArtifactLegalHold),
		rt(http.MethodPost, "/api/v1/retention/purge", AuthAuthenticated, ProxyNone, s.purgeRetention),
		rt(http.MethodGet, "/api/v1/credentials/catalog", AuthAuthenticated, ProxyBrowser, s.getCredentialCatalog),
		rt(http.MethodGet, "/api/v1/credentials", AuthAuthenticated, ProxyBrowser, s.listCredentials),
		rt(http.MethodPost, "/api/v1/credentials", AuthAuthenticated, ProxyBrowser, s.createCredential),
		rt(http.MethodGet, "/api/v1/credentials/{credentialId}", AuthAuthenticated, ProxyBrowser, s.getCredential),
		rt(http.MethodPatch, "/api/v1/credentials/{credentialId}", AuthAuthenticated, ProxyBrowser, s.updateCredential),
		rt(http.MethodPost, "/api/v1/credentials/{credentialId}/rotate", AuthAuthenticated, ProxyBrowser, s.rotateCredential),
		rt(http.MethodPost, "/api/v1/credentials/{credentialId}/disable", AuthAuthenticated, ProxyBrowser, s.disableCredential),
		rt(http.MethodPost, "/api/v1/credentials/{credentialId}/enable", AuthAuthenticated, ProxyBrowser, s.enableCredential),
		rt(http.MethodPost, "/api/v1/credentials/{credentialId}/test", AuthAuthenticated, ProxyBrowser, s.testCredential),
		rt(http.MethodPost, "/api/v1/credentials/{credentialId}/use", AuthAuthenticated, ProxyBrowser, s.useVaultCredential),
		rt(http.MethodGet, "/api/v1/credentials/{credentialId}/usage", AuthAuthenticated, ProxyBrowser, s.getCredentialUsage),
		rt(http.MethodGet, "/api/v1/credentials/{credentialId}/deletion-impact", AuthAuthenticated, ProxyBrowser, s.getCredentialDeletionImpact),
		rt(http.MethodDelete, "/api/v1/credentials/{credentialId}", AuthAuthenticated, ProxyBrowser, s.deleteCredential),
		rt(http.MethodGet, "/api/v1/credentials/{credentialId}/events", AuthAuthenticated, ProxyBrowser, s.listCredentialEvents),
		rt(http.MethodGet, "/api/v1/ops-config/catalog", AuthAuthenticated, ProxyBrowser, s.getOpsCatalog),
		rt(http.MethodGet, "/api/v1/kubernetes/catalog", AuthAuthenticated, ProxyBrowser, s.getKubernetesCatalog),
		rt(http.MethodGet, "/api/v1/ssh/catalog", AuthAuthenticated, ProxyBrowser, s.getSSHCatalog),
		rt(http.MethodGet, "/api/v1/scripts/catalog", AuthAuthenticated, ProxyBrowser, s.getScriptCatalog),
		rt(http.MethodGet, "/api/v1/http/catalog", AuthAuthenticated, ProxyBrowser, s.getHTTPCatalog),
		rt(http.MethodPost, "/api/v1/scripts", AuthAuthenticated, ProxyBrowser, s.publishScript),
		rt(http.MethodGet, "/api/v1/scripts/{artifactId}", AuthAuthenticated, ProxyBrowser, s.getScriptArtifact),
		rt(http.MethodPost, "/api/v1/scripts/{artifactId}/revoke", AuthAuthenticated, ProxyBrowser, s.revokeScriptArtifact),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}/script-artifacts", AuthAuthenticated, ProxyBrowser, s.listWorkflowScriptArtifacts),
		rt(http.MethodPost, "/api/v1/ops-config/select", AuthAuthenticated, ProxyBrowser, s.selectOpsBatch),
		rt(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}/pins", AuthAuthenticated, ProxyBrowser, s.listWorkflowVersionPins),
	}
	out = append(out, opsRoutes(s)...)
	out = append(out,
		rt(http.MethodGet, "/api/v1/approvals/catalog", AuthAuthenticated, ProxyBrowser, s.getApprovalCatalog),
		rt(http.MethodPost, "/api/v1/policy/evaluate", AuthAuthenticated, ProxyBrowser, s.evaluatePolicy),
		rt(http.MethodGet, "/api/v1/approvals", AuthAuthenticated, ProxyBrowser, s.listApprovals),
		rt(http.MethodPost, "/api/v1/approvals", AuthAuthenticated, ProxyBrowser, s.createApprovals),
		rt(http.MethodGet, "/api/v1/approvals/{approvalId}", AuthAuthenticated, ProxyBrowser, s.getApproval),
		rt(http.MethodPost, "/api/v1/approvals/{approvalId}/decide", AuthAuthenticated, ProxyBrowser, s.decideApproval),
		rt(http.MethodGet, "/api/v1/approvals/{approvalId}/events", AuthAuthenticated, ProxyBrowser, s.listApprovalEvents),
	)
	return out
}

func opsRoutes(s *Server) []Route {
	var out []Route
	for _, info := range opsconfig.KindInfos() {
		kind := info.Kind
		col := "/api/v1/" + info.Collection
		out = append(out,
			rtRef(http.MethodGet, col, AuthAuthenticated, ProxyBrowser, refOpsCollection, s.listOpsResources(kind)),
			rtRef(http.MethodPost, col, AuthAuthenticated, ProxyBrowser, refOpsCollection, s.createOpsResource(kind)),
			rtRef(http.MethodGet, col+"/{resourceId}", AuthAuthenticated, ProxyBrowser, refOpsItem, s.getOpsResource(kind)),
			rtRef(http.MethodGet, col+"/{resourceId}/draft", AuthAuthenticated, ProxyBrowser, refOpsDraft, s.getOpsDraft(kind)),
			rtRef(http.MethodPut, col+"/{resourceId}/draft", AuthAuthenticated, ProxyBrowser, refOpsDraft, s.putOpsDraft(kind)),
			rtRef(http.MethodPost, col+"/{resourceId}/publish", AuthAuthenticated, ProxyBrowser, refOpsPublish, s.publishOpsResource(kind)),
			rtRef(http.MethodGet, col+"/{resourceId}/versions", AuthAuthenticated, ProxyBrowser, refOpsVersions, s.listOpsVersions(kind)),
			rtRef(http.MethodGet, col+"/{resourceId}/versions/{versionId}", AuthAuthenticated, ProxyBrowser, refOpsVersion, s.getOpsVersion(kind)),
			rtRef(http.MethodPost, col+"/{resourceId}/disable", AuthAuthenticated, ProxyBrowser, refOpsDisable, s.disableOpsResource(kind)),
			rtRef(http.MethodPost, col+"/{resourceId}/enable", AuthAuthenticated, ProxyBrowser, refOpsEnable, s.enableOpsResource(kind)),
			rtRef(http.MethodPost, col+"/{resourceId}/select", AuthAuthenticated, ProxyBrowser, refOpsSelect, s.selectOpsResource(kind)),
		)
	}
	return out
}

const (
	refOpsCollection = "#/components/pathItems/OpsCollection"
	refOpsItem       = "#/components/pathItems/OpsItem"
	refOpsDraft      = "#/components/pathItems/OpsDraft"
	refOpsPublish    = "#/components/pathItems/OpsPublish"
	refOpsVersions   = "#/components/pathItems/OpsVersions"
	refOpsVersion    = "#/components/pathItems/OpsVersion"
	refOpsDisable    = "#/components/pathItems/OpsDisable"
	refOpsEnable     = "#/components/pathItems/OpsEnable"
	refOpsSelect     = "#/components/pathItems/OpsSelect"
)

func rt(method, pattern string, auth AuthClass, proxy ProxyClass, h http.HandlerFunc) Route {
	return Route{Method: method, Pattern: pattern, Auth: auth, Proxy: proxy, Handler: h}
}

func rtRef(method, pattern string, auth AuthClass, proxy ProxyClass, ref string, h http.HandlerFunc) Route {
	r := rt(method, pattern, auth, proxy, h)
	r.SpecRef = ref
	return r
}
