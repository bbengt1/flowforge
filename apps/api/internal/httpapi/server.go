package httpapi

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/bbengt1/flowforge/apps/api/openapi"
	"gopkg.in/yaml.v3"
)

// Server is the versioned control-plane HTTP API.
type Server struct {
	db               postgres.Checker
	store            identity.Store
	scoped           isolation.Store
	cache            *isolation.Cache
	sessions         session.Store
	workflows        wfstore.Store
	vault            vault.Store
	hooks            webhook.Store
	schedules        schedule.Store
	ops              opsconfig.Store
	approvals        approval.Store
	alerts           opsalert.Store
	keys             vault.Keys
	jobKey           []byte
	scriptKey        []byte
	scripts          *scripts.Pipeline
	objects          artifact.Objects
	downloadTTL      time.Duration
	artifactMaxBytes int
	log              *slog.Logger
	registry         *observability.Registry
	sec              Security
	clock            func() time.Time
	embedKeys        embed.Material
	embedRing        *embed.Ring
	embedJTI         embed.JTIConsumer
	embedMintIssuers []string
	portalIssuers    []string
	portalFrames     []string
	platformAdmins   []authz.PrincipalRef
	embedLimiter     *embed.Limiter
	embedAuditor     embed.Auditor
	embedNBFLeeway   time.Duration
}

// Deps configures a Server. Tests inject stores, security policy, and a clock.
type Deps struct {
	DB                   postgres.Checker
	Store                identity.Store
	Scoped               isolation.Store
	Sessions             session.Store
	Workflows            wfstore.Store
	Vault                vault.Store
	Hooks                webhook.Store
	Schedules            schedule.Store
	Ops                  opsconfig.Store
	Approvals            approval.Store
	Alerts               opsalert.Store
	Keys                 vault.Keys
	JobBindingKey        []byte
	ScriptSigningKey     []byte
	Scripts              scripts.Store
	Objects              artifact.Objects
	DownloadTTL          time.Duration
	ArtifactMaxBytes     int
	Cache                *isolation.Cache
	Log                  *slog.Logger
	Registry             *observability.Registry
	Security             Security
	Now                  func() time.Time
	EmbedKeys            embed.Material
	EmbedRing            *embed.Ring
	EmbedJTI             embed.JTIConsumer
	EmbedIssuers         []string
	PortalIssuers        []string
	PortalFrameAncestors []string
	PlatformAdmins       []authz.PrincipalRef
	EmbedLimits          embed.Limits
	EmbedAuditor         embed.Auditor
	// EmbedNBFLeeway is nbf clock-skew only (ADV-017). Zero uses the
	// documented default (30s). Values above 60s are clamped.
	EmbedNBFLeeway time.Duration
}

// New returns a handler for /api/v1 foundation routes.
func New(db postgres.Checker) http.Handler {
	return NewWithSecurity(db, Security{})
}

// NewWithSecurity returns a handler with TLS/proxy/CORS/session policy applied.
func NewWithSecurity(db postgres.Checker, sec Security) http.Handler {
	idStore, scoped, sessions, workflows := inferStores(db)
	return NewWithDeps(Deps{
		DB:        db,
		Store:     idStore,
		Scoped:    scoped,
		Sessions:  sessions,
		Workflows: workflows,
		Keys:      sec.VaultKeys,
		Security:  sec,
	})
}

// NewWithStore returns a handler with an explicit identity store (tests).
func NewWithStore(db postgres.Checker, store identity.Store) http.Handler {
	return NewWithStores(db, store, isolation.NewMemory())
}

// NewWithStores returns a handler with explicit identity and isolation stores.
// HTTP unit tests use this constructor: it enables trusted-dev identity
// headers and lists the identifiedRequest caller as a platform-admin so
// existing suite bootstrap stays usable. Production uses NewWithDeps with
// config.Load() (fail-closed).
func NewWithStores(db postgres.Checker, store identity.Store, scoped isolation.Store) http.Handler {
	if scoped == nil {
		scoped = isolation.NewMemory()
	}
	return NewWithDeps(withHTTPTestIdentity(Deps{DB: db, Store: store, Scoped: scoped, Sessions: session.NewMemory(), Workflows: wfstore.NewMemory()}))
}

// httpTestIssuer/Subject match identifiedRequest in HTTP unit tests.
const (
	httpTestIssuer  = "https://idp.example"
	httpTestSubject = "admin-1"
)

// withHTTPTestIdentity enables trusted-dev header identity and, when the
// caller did not set PlatformAdmins, lists the default HTTP unit-test
// principal as a platform-admin. Production must not call this.
func withHTTPTestIdentity(d Deps) Deps {
	d.Security.TrustIdentityHeaders = true
	if d.PlatformAdmins == nil {
		d.PlatformAdmins = []authz.PrincipalRef{{Issuer: httpTestIssuer, Subject: httpTestSubject}}
	}
	return d
}

// NewWithDeps returns a handler with explicit dependencies.
func NewWithDeps(d Deps) http.Handler {
	return newServer(d)
}

func inferStores(db postgres.Checker) (identity.Store, isolation.Store, session.Store, wfstore.Store) {
	if p, ok := db.(*postgres.Pool); ok {
		return identity.NewPostgres(p), isolation.NewPostgres(p), session.NewPostgres(p), wfstore.NewPostgres(p)
	}
	return nil, isolation.NewMemory(), session.NewMemory(), wfstore.NewMemory()
}

func inferVault(db postgres.Checker, keys vault.Keys, workflows wfstore.Store, ops opsconfig.Store, hooks webhook.Store) vault.Store {
	refs := vault.CompositeRefFinder{workflows, ops, hooks}
	if p, ok := db.(*postgres.Pool); ok {
		return vault.NewPostgres(p, keys, refs)
	}
	return vault.NewMemory(keys, refs)
}

func inferHooks(db postgres.Checker) webhook.Store {
	if p, ok := db.(*postgres.Pool); ok {
		return webhook.NewPostgres(p)
	}
	return webhook.NewMemory()
}

func inferSchedules(db postgres.Checker) schedule.Store {
	if p, ok := db.(*postgres.Pool); ok {
		return schedule.NewPostgres(p)
	}
	return schedule.NewMemory()
}

func inferOps(db postgres.Checker) opsconfig.Store {
	if p, ok := db.(*postgres.Pool); ok {
		return opsconfig.NewPostgres(p)
	}
	return opsconfig.NewMemory()
}

func inferApprovals(db postgres.Checker) approval.Store {
	if p, ok := db.(*postgres.Pool); ok {
		return approval.NewPostgres(p)
	}
	return approval.NewMemory()
}

func inferScripts(db postgres.Checker) scripts.Store {
	if p, ok := db.(*postgres.Pool); ok {
		return scripts.NewPostgres(p)
	}
	return scripts.NewMemory()
}

func inferAlerts(db postgres.Checker) opsalert.Store {
	if p, ok := db.(*postgres.Pool); ok {
		return opsalert.NewPostgres(p)
	}
	return opsalert.NewMemory()
}

func newServer(d Deps) http.Handler {
	// Production cmd/api uses NewWithDeps with a postgres.Pool and no
	// explicit Store. Infer identity / isolation / session / workflow
	// stores from that pool so mint, membership, and exchange can run.
	// Tests that inject stores keep them. Nil store + non-pool DB still
	// fail closed (503) via requireStore.
	if d.Store == nil || d.Scoped == nil || d.Sessions == nil || d.Workflows == nil {
		infStore, infScoped, infSessions, infWorkflows := inferStores(d.DB)
		if d.Store == nil {
			d.Store = infStore
		}
		if d.Scoped == nil {
			d.Scoped = infScoped
		}
		if d.Sessions == nil {
			d.Sessions = infSessions
		}
		if d.Workflows == nil {
			d.Workflows = infWorkflows
		}
	}
	log := d.Log
	if log == nil {
		log = slog.Default()
	}
	registry := d.Registry
	if registry == nil {
		registry = observability.NewRegistry()
	}
	cache := d.Cache
	if cache == nil {
		cache = isolation.NewCache()
	}
	sessions := d.Sessions
	if sessions == nil {
		sessions = session.NewMemory()
	}
	workflows := d.Workflows
	if workflows == nil {
		workflows = wfstore.NewMemory()
	}
	keys := d.Keys
	opsStore := d.Ops
	if opsStore == nil {
		opsStore = inferOps(d.DB)
	}
	approvalStore := d.Approvals
	if approvalStore == nil {
		approvalStore = inferApprovals(d.DB)
	}
	alertStore := d.Alerts
	if alertStore == nil {
		alertStore = inferAlerts(d.DB)
	}
	hookStore := d.Hooks
	if hookStore == nil {
		hookStore = inferHooks(d.DB)
	}
	scheduleStore := d.Schedules
	if scheduleStore == nil {
		scheduleStore = inferSchedules(d.DB)
	}
	vaultStore := d.Vault
	if vaultStore == nil {
		vaultStore = inferVault(d.DB, keys, workflows, opsStore, hookStore)
	}
	clock := d.Now
	if clock == nil {
		clock = time.Now
	}
	if v := strings.TrimSpace(os.Getenv("INTEGRATION_ACTIONS_ENABLED")); v == "0" || strings.EqualFold(v, "false") {
		workflow.IntegrationActionsEnabled = false
	}
	jobKey := d.JobBindingKey
	if len(jobKey) == 0 {
		jobKey = d.Security.JobBindingKey
	}
	if len(jobKey) == 0 {
		jobKey = wfstore.LoadJobBindingKey()
	}
	scriptKey := d.ScriptSigningKey
	if len(scriptKey) == 0 {
		scriptKey = scripts.LoadSigningKey()
	}
	scriptStore := d.Scripts
	if scriptStore == nil {
		scriptStore = inferScripts(d.DB)
	}
	objects := d.Objects
	if objects == nil {
		if root := strings.TrimSpace(os.Getenv("ARTIFACT_STORE_DIR")); root != "" {
			if fsStore, err := artifact.NewFilesystemObjects(root); err == nil {
				objects = fsStore
			}
		}
	}
	if objects == nil {
		objects = artifact.NewMemoryObjects()
	}
	downloadTTL := d.DownloadTTL
	if downloadTTL <= 0 {
		downloadTTL = wfstore.DefaultDownloadTTL
	}
	s := &Server{
		db:               d.DB,
		store:            d.Store,
		scoped:           d.Scoped,
		cache:            cache,
		sessions:         sessions,
		workflows:        workflows,
		vault:            vaultStore,
		hooks:            hookStore,
		schedules:        scheduleStore,
		ops:              opsStore,
		approvals:        approvalStore,
		alerts:           alertStore,
		keys:             keys,
		jobKey:           jobKey,
		scriptKey:        scriptKey,
		scripts:          &scripts.Pipeline{Store: scriptStore, Key: scriptKey},
		objects:          objects,
		downloadTTL:      downloadTTL,
		artifactMaxBytes: d.ArtifactMaxBytes,
		log:              log,
		registry:         registry,
		sec:              d.Security,
		clock:            clock,
		embedKeys:        d.EmbedKeys,
		embedRing:        d.EmbedRing,
		embedJTI:         d.EmbedJTI,
		embedMintIssuers: append([]string(nil), d.EmbedIssuers...),
		portalIssuers:    append([]string(nil), d.PortalIssuers...),
		portalFrames:     append([]string(nil), d.PortalFrameAncestors...),
		embedLimiter:     embed.NewLimiter(d.EmbedLimits),
		embedAuditor:     d.EmbedAuditor,
		embedNBFLeeway:   embed.NormalizeNBFLeeway(d.EmbedNBFLeeway),
	}
	if d.PlatformAdmins != nil {
		s.platformAdmins = append([]authz.PrincipalRef(nil), d.PlatformAdmins...)
	} else {
		s.platformAdmins = authz.ParsePlatformAdmins(os.Getenv(authz.EnvPlatformAdmins), os.Getenv(authz.EnvPlatformAdmin))
	}
	if !s.embedKeys.Ready() {
		if loaded, err := embed.LoadMaterial(); err == nil {
			s.embedKeys = loaded
		}
		// Production LoadMaterial fails closed when the key is missing.
		// Do not mint a boot-only ephemeral key here (ADV-006).
	}
	if s.embedRing == nil {
		var store embed.KeyStore
		if p, ok := d.DB.(*postgres.Pool); ok {
			store = embed.NewPostgresKeys(p)
		}
		s.embedRing = embed.NewRing(s.embedKeys, store)
		_ = s.embedRing.Refresh(context.Background(), time.Now().UTC())
	}
	if s.embedJTI == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.embedJTI = embed.NewPostgresJTI(p)
		} else {
			s.embedJTI = embed.NewMemoryJTI()
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("GET /api/v1/readiness", s.readiness)
	mux.HandleFunc("GET /api/v1/metrics", s.metrics)
	mux.HandleFunc("GET /api/v1/openapi.yaml", s.openapiYAML)
	mux.HandleFunc("GET /api/v1/openapi.json", s.openapiJSON)
	mux.HandleFunc("GET /api/v1/swagger", s.swagger)
	mux.HandleFunc("GET /api/v1/permission-matrix", s.getPermissionMatrix)
	mux.HandleFunc("GET /api/v1/roles", s.getRoles)
	mux.HandleFunc("GET /api/v1/permissions", s.getPermissions)
	mux.HandleFunc("POST /api/v1/tenants", s.createTenant)
	mux.HandleFunc("GET /api/v1/workspaces", s.listWorkspaces)
	mux.HandleFunc("POST /api/v1/workspaces", s.createWorkspace)
	mux.HandleFunc("GET /api/v1/workspace", s.getCurrentWorkspace)
	mux.HandleFunc("DELETE /api/v1/workspace", s.deleteWorkspace)
	mux.HandleFunc("GET /api/v1/workspace/members", s.listMembers)
	mux.HandleFunc("PUT /api/v1/workspace/members", s.putMember)
	mux.HandleFunc("DELETE /api/v1/workspace/members/{userID}", s.deleteMember)
	mux.HandleFunc("GET /api/v1/workspace/records", s.listRecords)
	mux.HandleFunc("POST /api/v1/workspace/records", s.createRecord)
	mux.HandleFunc("GET /api/v1/workspace/records/{id}", s.getRecord)
	mux.HandleFunc("POST /api/v1/workspace/records/{id}/links", s.createRecordLink)
	mux.HandleFunc("POST /api/v1/workspace/credentials/{id}/use", s.useCredential)
	mux.HandleFunc("GET /api/v1/workspace/artifacts/{id}", s.getArtifact)
	mux.HandleFunc("GET /api/v1/workspace/jobs", s.listJobs)
	mux.HandleFunc("POST /api/v1/workspace/jobs", s.createJob)
	mux.HandleFunc("GET /api/v1/workspace/cache/{key}", s.getCache)
	mux.HandleFunc("PUT /api/v1/workspace/cache/{key}", s.putCache)
	mux.HandleFunc("POST /api/v1/workspace/realtime/channels/{id}/subscribe", s.subscribeRealtime)
	mux.HandleFunc("GET /api/v1/workspace/audit-events", s.listAuditEvents)
	mux.HandleFunc("POST /api/v1/session", s.createSession)
	mux.HandleFunc("GET /api/v1/session", s.getSession)
	mux.HandleFunc("POST /api/v1/session/refresh", s.refreshSession)
	mux.HandleFunc("POST /api/v1/session/logout", s.logoutSession)
	mux.HandleFunc("GET /api/v1/session/audit-events", s.listSessionAudit)
	mux.HandleFunc("GET /api/v1/embed/catalog", s.getEmbedCatalog)
	mux.HandleFunc("GET /api/v1/embed/jwks", s.getEmbedJWKS)
	mux.HandleFunc("POST /api/v1/embed/assertions", s.mintEmbedAssertion)
	mux.HandleFunc("POST /api/v1/embed/exchange", s.exchangeEmbedAssertion)
	mux.HandleFunc("POST /api/v1/embed/keys/rotate", s.rotateEmbedKeys)
	mux.HandleFunc("GET /api/v1/portal/adapter", s.getPortalAdapter)
	mux.HandleFunc("POST /api/v1/portal/adapter/assertions", s.mintPortalAssertion)
	mux.HandleFunc("GET /api/v1/workflows/catalog", s.getWorkflowCatalog)
	mux.HandleFunc("POST /api/v1/workflows/validate", s.validateWorkflow)
	mux.HandleFunc("POST /api/v1/workflows/normalize", s.normalizeWorkflow)
	mux.HandleFunc("GET /api/v1/workflows", s.listWorkflows)
	mux.HandleFunc("POST /api/v1/workflows", s.createWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}", s.getWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/draft", s.getWorkflowDraft)
	mux.HandleFunc("PUT /api/v1/workflows/{workflowId}/draft", s.putWorkflowDraft)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/publish", s.publishWorkflow)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/compare", s.compareWorkflow)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions", s.listWorkflowVersions)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions/{versionId}", s.getWorkflowVersion)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions/{versionId}/export", s.exportWorkflowVersion)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/versions/{versionId}/restore", s.restoreWorkflowVersion)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/triggers", s.listWorkflowTriggers)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/triggers", s.createWorkflowTrigger)
	mux.HandleFunc("GET /api/v1/triggers/{triggerId}", s.getTrigger)
	mux.HandleFunc("PATCH /api/v1/triggers/{triggerId}", s.updateTrigger)
	mux.HandleFunc("POST /api/v1/triggers/{triggerId}/rotate", s.rotateTrigger)
	mux.HandleFunc("POST /api/v1/triggers/{triggerId}/disable", s.disableTrigger)
	mux.HandleFunc("POST /api/v1/triggers/{triggerId}/enable", s.enableTrigger)
	mux.HandleFunc("DELETE /api/v1/triggers/{triggerId}", s.deleteTrigger)
	mux.HandleFunc("POST /api/v1/hooks/{publicId}", s.deliverWebhook)
	mux.HandleFunc("GET /api/v1/schedules/catalog", s.getScheduleCatalog)
	mux.HandleFunc("GET /api/v1/schedules", s.listSchedules)
	mux.HandleFunc("POST /api/v1/schedules", s.createSchedule)
	mux.HandleFunc("POST /api/v1/schedules/dispatch", s.dispatchSchedules)
	mux.HandleFunc("GET /api/v1/schedules/{scheduleId}", s.getSchedule)
	mux.HandleFunc("PATCH /api/v1/schedules/{scheduleId}", s.updateSchedule)
	mux.HandleFunc("POST /api/v1/schedules/{scheduleId}/enable", s.enableSchedule)
	mux.HandleFunc("POST /api/v1/schedules/{scheduleId}/disable", s.disableSchedule)
	mux.HandleFunc("DELETE /api/v1/schedules/{scheduleId}", s.deleteSchedule)
	mux.HandleFunc("POST /api/v1/workflows/{workflowId}/executions", s.startWorkflowExecution)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/executions", s.listWorkflowExecutions)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/executions/{executionId}", s.getWorkflowExecution)
	mux.HandleFunc("GET /api/v1/executions", s.listWorkspaceExecutions)
	mux.HandleFunc("GET /api/v1/executions/{executionId}", s.getWorkspaceExecution)
	mux.HandleFunc("GET /api/v1/executions/{executionId}/steps", s.listExecutionSteps)
	mux.HandleFunc("GET /api/v1/executions/{executionId}/steps/{stepId}", s.getExecutionStep)
	mux.HandleFunc("GET /api/v1/executions/{executionId}/steps/{stepId}/logs", s.getStepLogs)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/steps/{stepId}/logs", s.uploadStepArtifact)
	mux.HandleFunc("GET /api/v1/executions/{executionId}/artifacts", s.listExecutionArtifacts)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/artifacts", s.uploadExecutionArtifact)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/steps/{stepId}/artifacts", s.uploadStepArtifact)
	mux.HandleFunc("GET /api/v1/executions/{executionId}/jobs", s.listExecutionJobs)
	mux.HandleFunc("GET /api/v1/executions/{executionId}/audit-events", s.listExecutionAuditEvents)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/cancel", s.cancelExecution)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/emergency-stop", s.emergencyStopExecution)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/steps/{stepId}/emergency-stop", s.emergencyStopExecution)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/retry", s.retryExecution)
	mux.HandleFunc("POST /api/v1/executions/{executionId}/steps/{stepId}/retry", s.retryExecution)
	mux.HandleFunc("POST /api/v1/jobs/claim", s.claimJob)
	mux.HandleFunc("POST /api/v1/jobs/recover", s.recoverJobs)
	mux.HandleFunc("POST /api/v1/jobs/{jobId}/heartbeat", s.heartbeatJob)
	mux.HandleFunc("POST /api/v1/jobs/{jobId}/release", s.releaseJob)
	mux.HandleFunc("POST /api/v1/jobs/{jobId}/complete", s.completeJob)
	mux.HandleFunc("POST /api/v1/jobs/{jobId}/fail", s.failJob)
	mux.HandleFunc("GET /api/v1/audit-events", s.listProductAuditEvents)
	mux.HandleFunc("GET /api/v1/alerts", s.listOperationalAlerts)
	mux.HandleFunc("GET /api/v1/alerts/{alertId}", s.getOperationalAlert)
	mux.HandleFunc("POST /api/v1/alerts/{alertId}/ack", s.ackOperationalAlert)
	mux.HandleFunc("GET /api/v1/artifacts/{artifactId}", s.getProductArtifact)
	mux.HandleFunc("POST /api/v1/artifacts/{artifactId}/downloads", s.createArtifactDownload)
	mux.HandleFunc("GET /api/v1/artifact-downloads/{grantId}", s.streamArtifactDownload)
	mux.HandleFunc("POST /api/v1/artifacts/{artifactId}/legal-hold", s.setArtifactLegalHold)
	mux.HandleFunc("POST /api/v1/retention/purge", s.purgeRetention)
	mux.HandleFunc("GET /api/v1/credentials/catalog", s.getCredentialCatalog)
	mux.HandleFunc("GET /api/v1/credentials", s.listCredentials)
	mux.HandleFunc("POST /api/v1/credentials", s.createCredential)
	mux.HandleFunc("GET /api/v1/credentials/{credentialId}", s.getCredential)
	mux.HandleFunc("PATCH /api/v1/credentials/{credentialId}", s.updateCredential)
	mux.HandleFunc("POST /api/v1/credentials/{credentialId}/rotate", s.rotateCredential)
	mux.HandleFunc("POST /api/v1/credentials/{credentialId}/disable", s.disableCredential)
	mux.HandleFunc("POST /api/v1/credentials/{credentialId}/enable", s.enableCredential)
	mux.HandleFunc("POST /api/v1/credentials/{credentialId}/test", s.testCredential)
	mux.HandleFunc("POST /api/v1/credentials/{credentialId}/use", s.useVaultCredential)
	mux.HandleFunc("GET /api/v1/credentials/{credentialId}/usage", s.getCredentialUsage)
	mux.HandleFunc("GET /api/v1/credentials/{credentialId}/deletion-impact", s.getCredentialDeletionImpact)
	mux.HandleFunc("DELETE /api/v1/credentials/{credentialId}", s.deleteCredential)
	mux.HandleFunc("GET /api/v1/credentials/{credentialId}/events", s.listCredentialEvents)
	mux.HandleFunc("GET /api/v1/ops-config/catalog", s.getOpsCatalog)
	mux.HandleFunc("GET /api/v1/kubernetes/catalog", s.getKubernetesCatalog)
	mux.HandleFunc("GET /api/v1/ssh/catalog", s.getSSHCatalog)
	mux.HandleFunc("GET /api/v1/scripts/catalog", s.getScriptCatalog)
	mux.HandleFunc("GET /api/v1/http/catalog", s.getHTTPCatalog)
	mux.HandleFunc("POST /api/v1/scripts", s.publishScript)
	mux.HandleFunc("GET /api/v1/scripts/{artifactId}", s.getScriptArtifact)
	mux.HandleFunc("POST /api/v1/scripts/{artifactId}/revoke", s.revokeScriptArtifact)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions/{versionId}/script-artifacts", s.listWorkflowScriptArtifacts)
	mux.HandleFunc("POST /api/v1/ops-config/select", s.selectOpsBatch)
	mux.HandleFunc("GET /api/v1/workflows/{workflowId}/versions/{versionId}/pins", s.listWorkflowVersionPins)
	for _, info := range opsconfig.KindInfos() {
		kind := info.Kind
		col := info.Collection
		mux.HandleFunc("GET /api/v1/"+col, s.listOpsResources(kind))
		mux.HandleFunc("POST /api/v1/"+col, s.createOpsResource(kind))
		mux.HandleFunc("GET /api/v1/"+col+"/{resourceId}", s.getOpsResource(kind))
		mux.HandleFunc("GET /api/v1/"+col+"/{resourceId}/draft", s.getOpsDraft(kind))
		mux.HandleFunc("PUT /api/v1/"+col+"/{resourceId}/draft", s.putOpsDraft(kind))
		mux.HandleFunc("POST /api/v1/"+col+"/{resourceId}/publish", s.publishOpsResource(kind))
		mux.HandleFunc("GET /api/v1/"+col+"/{resourceId}/versions", s.listOpsVersions(kind))
		mux.HandleFunc("GET /api/v1/"+col+"/{resourceId}/versions/{versionId}", s.getOpsVersion(kind))
		mux.HandleFunc("POST /api/v1/"+col+"/{resourceId}/disable", s.disableOpsResource(kind))
		mux.HandleFunc("POST /api/v1/"+col+"/{resourceId}/enable", s.enableOpsResource(kind))
		mux.HandleFunc("POST /api/v1/"+col+"/{resourceId}/select", s.selectOpsResource(kind))
	}
	mux.HandleFunc("GET /api/v1/approvals/catalog", s.getApprovalCatalog)
	mux.HandleFunc("POST /api/v1/policy/evaluate", s.evaluatePolicy)
	mux.HandleFunc("GET /api/v1/approvals", s.listApprovals)
	mux.HandleFunc("POST /api/v1/approvals", s.createApprovals)
	mux.HandleFunc("GET /api/v1/approvals/{approvalId}", s.getApproval)
	mux.HandleFunc("POST /api/v1/approvals/{approvalId}/decide", s.decideApproval)
	mux.HandleFunc("GET /api/v1/approvals/{approvalId}/events", s.listApprovalEvents)

	router := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rec, allow := muxMethodNotAllowed(mux, r); rec != "" {
			setRoute(r, routePattern(mux, r))
			w.Header().Set("Allow", allow)
			WriteProblem(w, r, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed", rec)
			return
		}
		if !hasExactRoute(mux, r) {
			setRoute(r, "unmatched")
			WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested path does not exist.")
			return
		}
		setRoute(r, routePattern(mux, r))
		mux.ServeHTTP(w, r)
	})

	return withRequestID(withSecureHeaders(s.sec, withObserve(log, registry, withRecover(log, withBodyLimit(s.withOriginPolicy(router))))))
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) readiness(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return
	}
	if err := s.db.Ping(r.Context()); err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "PostgreSQL is not reachable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = s.registry.WritePrometheus(w)
}

func (s *Server) openapiYAML(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(mustOpenAPIYAML())
}

func (s *Server) openapiJSON(w http.ResponseWriter, r *http.Request) {
	var doc any
	if err := yaml.Unmarshal(mustOpenAPIYAML(), &doc); err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "OpenAPI document could not be published.")
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) swagger(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(swaggerHTML))
}

const swaggerHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FlowForge API</title>
</head>
<body>
  <h1>FlowForge Control Plane API</h1>
  <p>Published specification:</p>
  <ul>
    <li><a href="/api/v1/openapi.yaml">OpenAPI YAML</a></li>
    <li><a href="/api/v1/openapi.json">OpenAPI JSON</a></li>
  </ul>
</body>
</html>
`

func mustOpenAPIYAML() []byte {
	data, err := fs.ReadFile(openapi.FS, "openapi.yaml")
	if err != nil {
		return []byte("openapi: 3.0.3\ninfo:\n  title: FlowForge Control Plane API\n  version: 0.0.0\n")
	}
	return data
}

func hasExactRoute(mux *http.ServeMux, r *http.Request) bool {
	_, pattern := mux.Handler(r)
	return pattern != ""
}

var routedMethods = []string{
	http.MethodGet, http.MethodHead, http.MethodPost,
	http.MethodPut, http.MethodPatch, http.MethodDelete,
}

func routePattern(mux *http.ServeMux, r *http.Request) string {
	if _, pattern := mux.Handler(r); pattern != "" {
		return pattern
	}
	for _, method := range routedMethods {
		clone := r.Clone(context.Background())
		clone.Method = method
		if _, pattern := mux.Handler(clone); pattern != "" {
			return pattern
		}
	}
	return "unmatched"
}

func allowedMethods(mux *http.ServeMux, r *http.Request) []string {
	seen := map[string]bool{}
	var out []string
	for _, method := range routedMethods {
		clone := r.Clone(context.Background())
		clone.Method = method
		if _, pattern := mux.Handler(clone); pattern != "" && !seen[method] {
			seen[method] = true
			out = append(out, method)
		}
	}
	if seen[http.MethodGet] && !seen[http.MethodHead] {
		// HEAD is conventional for GET-only resources.
		withHead := make([]string, 0, len(out)+1)
		for _, method := range out {
			withHead = append(withHead, method)
			if method == http.MethodGet {
				withHead = append(withHead, http.MethodHead)
			}
		}
		out = withHead
	}
	return out
}

func muxMethodNotAllowed(mux *http.ServeMux, r *http.Request) (string, string) {
	if hasExactRoute(mux, r) {
		return "", ""
	}
	allowed := allowedMethods(mux, r)
	if len(allowed) == 0 {
		return "", ""
	}
	return "The " + r.Method + " method is not allowed for this path.", strings.Join(allowed, ", ")
}

// ReadyChecker adapts a ping function to postgres.Checker.
type ReadyChecker func(ctx context.Context) error

// Ping implements postgres.Checker.
func (f ReadyChecker) Ping(ctx context.Context) error { return f(ctx) }
