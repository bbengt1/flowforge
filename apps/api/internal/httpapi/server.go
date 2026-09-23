package httpapi

import (
	"bytes"
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
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/buildinfo"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/ha"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/lockout"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/mfa"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/oidc"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/quota"
	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/tlsmaterial"
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
	bootstrap        bootstrap.Store
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
	loginLimiter     *embed.Limiter
	machineLimiter   *embed.Limiter
	loginLimits      localauth.Limits
	quota            quota.Taker
	quotaLimits      quota.Limits
	machines         machine.Store
	machineConsumers machine.Consumers
	oidc             *oidc.Client
	mfa              mfa.Store
	mfaKey           []byte
	scimSettings     scim.Settings
	scimDir          scim.Store
	lockouts         lockout.Store
	lockoutMax       int
	embedAuditor     embed.Auditor
	embedNBFLeeway   time.Duration
	tlsMaterials     tlsmaterial.Store
}

// Deps configures a Server. Tests inject stores, security policy, and a clock.
type Deps struct {
	DB                   postgres.Checker
	Store                identity.Store
	Bootstrap            bootstrap.Store
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
	// LoginLimits rate-limits POST /login before bcrypt. Separate from
	// embed exchange so those IP budgets do not share a counter.
	LoginLimits localauth.Limits
	// Quota is the per-workspace token bucket. Zero uses documented
	// defaults. HTTP unit tests set Unlimited. QuotaStore overrides the
	// store; nil selects PostgreSQL when DB is a pool and memory otherwise.
	Quota      quota.Limits
	QuotaStore quota.Taker
	// Machines is the service-principal store. Nil selects Postgres when
	// DB is a pool and an in-memory store otherwise.
	Machines machine.Store
	// MachineConsumers fails closed for scrapers and the scheduler when
	// a named consumer's principal is missing, revoked, or ungranted.
	MachineConsumers machine.Consumers
	// OIDC is Authorization Code + PKCE. Zero value fails closed on
	// /oidc/start and /oidc/callback. It does not replace local login.
	OIDC oidc.Settings
	// MFAKey encrypts TOTP secrets. Empty fails closed when a
	// local-login or OIDC session needs step-up, enroll, or verify.
	MFAKey []byte
	// SCIM is the dedicated /scim/v2 bearer. Zero value fails closed
	// when those routes are called. It does not replace local login,
	// OIDC, machine principals, or embed exchange.
	SCIM scim.Settings
	// SCIMDir stores directory rows. Nil selects Postgres when DB is a
	// pool and an in-memory store otherwise.
	SCIMDir scim.Store
	// Lockouts is the durable failed-auth counter. Nil selects Postgres
	// when DB is a pool and an in-memory store otherwise.
	Lockouts lockout.Store
	// LockoutMaxFailures locks an account after this many bad local
	// passwords. Zero uses the default. Values outside 1..50 fail closed.
	LockoutMaxFailures int
	EmbedAuditor       embed.Auditor
	// EmbedNBFLeeway is nbf clock-skew only (ADV-017). Zero uses the
	// documented default (30s). Values above 60s are clamped.
	EmbedNBFLeeway time.Duration
	// TLSMaterials writes first-run cert/key PEMs to TLS_CERT_FILE /
	// TLS_KEY_FILE. Nil fails closed on create/upload; skip does not.
	TLSMaterials tlsmaterial.Store
	// Replicas is FLOWFORGE_REPLICAS. Zero and one allow in-memory
	// stores (unit tests and a single process). Above one refuses
	// process-local session and store backends. There is no sticky
	// session fallback.
	Replicas int
	// ArtifactBackend is the artifact.LoadStore kind (s3, filesystem,
	// or memory). Empty is unshared when Replicas is above one.
	ArtifactBackend string
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
	if len(d.JobBindingKey) == 0 && len(d.Security.JobBindingKey) == 0 {
		d.JobBindingKey = wfstore.NewJobBindingKey()
	}
	if d.Quota.IsZero() && d.QuotaStore == nil {
		d.Quota = quota.Unlimited()
	}
	if len(d.ScriptSigningKey) == 0 {
		d.ScriptSigningKey = scripts.NewSigningKey()
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

func inferBootstrap(db postgres.Checker) bootstrap.Store {
	if p, ok := db.(*postgres.Pool); ok {
		return bootstrap.NewPostgres(p)
	}
	return bootstrap.NewMemory()
}

func newServer(d Deps) *API {
	// Production cmd/api uses NewWithDeps with a postgres.Pool and no
	// explicit Store. Infer identity / isolation / session / workflow
	// stores from that pool so mint, membership, and exchange can run.
	// Tests that inject stores keep them. Nil store + non-pool DB still
	// fail closed (503) via requireStore.
	if d.Bootstrap == nil {
		d.Bootstrap = inferBootstrap(d.DB)
	}
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
		// Env only — never generate a per-process key. cmd/api passes
		// keys from config.Load(); HTTP tests inject via withHTTPTestIdentity.
		if loaded, err := wfstore.LoadJobBindingKey(); err == nil {
			jobKey = loaded
		}
	}
	scriptKey := d.ScriptSigningKey
	if len(scriptKey) == 0 {
		if loaded, err := scripts.LoadSigningKey(); err == nil {
			scriptKey = loaded
		}
	}
	scriptStore := d.Scripts
	if scriptStore == nil {
		scriptStore = inferScripts(d.DB)
	}
	objects := d.Objects
	if objects == nil {
		// Tests omit Deps.Objects and leave ARTIFACT_STORE_DIR unset, so they
		// keep the memory store. cmd/api always injects artifact.LoadStore.
		// A production-locked process with a directory set must not use it:
		// empty APP_ENV is production-locked, and that path used to be tmpfs.
		root := strings.TrimSpace(os.Getenv("ARTIFACT_STORE_DIR"))
		if root != "" && authz.ProductionLockedFromEnv() {
			objects = artifact.UnavailableObjects()
		} else if root != "" {
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
		bootstrap:        d.Bootstrap,
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
		loginLimits:      localauth.NormalizeLimits(d.LoginLimits),
		quotaLimits:      quota.Normalize(d.Quota),
		embedAuditor:     d.EmbedAuditor,
		embedNBFLeeway:   embed.NormalizeNBFLeeway(d.EmbedNBFLeeway),
		tlsMaterials:     d.TLSMaterials,
	}
	// Dedicated limiter: do not share embed's IP/principal counters.
	s.loginLimiter = embed.NewLimiter(embed.Limits{
		Window:            s.loginLimits.Window,
		ExchangeIP:        -1,
		ExchangePrincipal: -1,
		MintPrincipal:     -1,
	})
	if d.PlatformAdmins != nil {
		s.platformAdmins = append([]authz.PrincipalRef(nil), d.PlatformAdmins...)
	} else {
		s.platformAdmins = authz.ParsePlatformAdmins(os.Getenv(authz.EnvPlatformAdmins), os.Getenv(authz.EnvPlatformAdmin))
	}
	s.machines = d.Machines
	if s.machines == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.machines = machine.NewPostgres(p)
		} else {
			s.machines = machine.NewMemory()
		}
	}
	s.machineConsumers = d.MachineConsumers
	s.machineLimiter = embed.NewLimiter(embed.Limits{
		Window:            time.Minute,
		ExchangeIP:        -1,
		ExchangePrincipal: -1,
		MintPrincipal:     -1,
	})
	s.quota = d.QuotaStore
	if pool, ok := d.DB.(*postgres.Pool); ok {
		shared := quota.NewPostgres(pool)
		if s.quota == nil {
			s.quota = shared
		}
		s.embedLimiter.UseShared(shared)
		s.loginLimiter.UseShared(shared)
		s.machineLimiter.UseShared(shared)
	}
	if s.quota == nil {
		s.quota = quota.NewMemory()
	}
	if p, ok := d.DB.(*postgres.Pool); ok {
		s.mfa = mfa.NewPostgres(p)
		s.oidc = oidc.NewClient(d.OIDC, oidc.NewPostgres(p))
	} else {
		s.mfa = mfa.NewMemory()
		s.oidc = oidc.NewClient(d.OIDC, oidc.NewMemory())
	}
	if len(d.MFAKey) == 32 {
		s.mfaKey = append([]byte(nil), d.MFAKey...)
	}
	s.scimSettings = d.SCIM
	s.scimDir = d.SCIMDir
	if s.scimDir == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.scimDir = scim.NewPostgres(p)
		} else {
			s.scimDir = scim.NewMemory()
		}
	}
	s.lockouts = d.Lockouts
	if s.lockouts == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.lockouts = lockout.NewPostgres(p)
		} else {
			s.lockouts = lockout.NewMemory()
		}
	}
	s.lockoutMax = d.LockoutMaxFailures
	if s.lockoutMax == 0 {
		s.lockoutMax = lockout.DefaultMaxFailures
	}
	if s.lockoutMax < lockout.MinMaxFailures || s.lockoutMax > lockout.MaxMaxFailures {
		s.lockoutMax = 0
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
	// Routes is the mux source of truth. OpenAPI and the identity-proxy
	// allowlist are generated from it (go run ./cmd/genroutes).
	for _, rt := range Routes(s) {
		mux.HandleFunc(rt.Method+" "+rt.Pattern, rt.Handler)
	}

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

	unshared := unsharedBackends([]namedBackend{
		{"session", sessions},
		{"workflow", workflows},
		{"jti", s.embedJTI},
		{"lockout", s.lockouts},
		{"vault", vaultStore},
		{"identity", s.store},
		{"isolation", s.scoped},
		{"machine", s.machines},
		{"mfa", s.mfa},
		{"scim", s.scimDir},
		{"bootstrap", s.bootstrap},
		{"webhook", s.hooks},
		{"schedule", s.schedules},
		{"ops", s.ops},
		{"approval", s.approvals},
		{"alert", s.alerts},
		{"script", scriptStore},
	}, d.ArtifactBackend)
	if quotaUnshared(s.quota) {
		unshared = append(unshared, "rate")
	}
	if !s.loginLimiter.Shared() {
		unshared = append(unshared, "login-rate")
	}
	if !s.embedLimiter.Shared() {
		unshared = append(unshared, "embed-rate")
	}
	if !s.machineLimiter.Shared() {
		unshared = append(unshared, "machine-rate")
	}
	return &API{
		Handler:    withRequestID(withSecureHeaders(s.sec, withObserve(log, registry, withRecover(log, withBodyLimit(s.withOriginPolicy(router)))))),
		srv:        s,
		replicaErr: ha.RefuseUnshared(d.Replicas, unshared),
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	// Unlimited. Workspace quotas and auth-door limits do not apply.
	writeJSON(w, http.StatusOK, probeIdentity("ok"))
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
	writeJSON(w, http.StatusOK, probeIdentity("ready"))
}

// probeIdentity is the secret-free liveness/readiness body. version/sha
// come from ldflags or BUILD_* env; unsafe values become "dev"/"unknown"
// and never change the probe status.
func probeIdentity(status string) map[string]string {
	info := buildinfo.Resolve()
	return map[string]string{
		"status":  status,
		"version": info.Version,
		"sha":     info.SHA,
	}
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
	var buf bytes.Buffer
	if err := s.registry.WritePrometheus(&buf); err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "Metrics could not be published.")
		return
	}
	if err := observability.WriteOTelPrometheus(&buf); err != nil && s.log != nil {
		s.log.Error("opentelemetry metrics", "error", err)
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) openapiYAML(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/yaml")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(mustOpenAPIYAML())
}

func (s *Server) openapiJSON(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
	var doc any
	if err := yaml.Unmarshal(mustOpenAPIYAML(), &doc); err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "OpenAPI document could not be published.")
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) swagger(w http.ResponseWriter, r *http.Request) {
	if !s.requirePlatformOpsRead(w, r) {
		return
	}
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
