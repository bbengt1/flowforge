package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/ha"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
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
)

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
	// Replicas is FLOWFORGE_REPLICAS. Zero and one do not apply the
	// multi-replica refusal (unit tests and a single process). Above
	// one refuses process-local session and store backends. A
	// production-locked process refuses those same backends even at
	// one replica. There is no sticky session fallback and no
	// production memory override.
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
	// Non-pool composition keeps memory for unit tests and local/dev.
	// cmd/api refuses that result when the process is production-locked.
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
	if wfMem, ok := workflows.(*wfstore.Memory); ok {
		if apMem, ok := approvalStore.(*approval.Memory); ok {
			apMem.SetGateWaiting(wfMem.ApprovalGateWaiting)
		}
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
		DB:               d.DB,
		Store:            d.Store,
		Bootstrap:        d.Bootstrap,
		Scoped:           d.Scoped,
		Cache:            cache,
		Sessions:         sessions,
		Workflows:        workflows,
		Vault:            vaultStore,
		Hooks:            hookStore,
		Schedules:        scheduleStore,
		Ops:              opsStore,
		Approvals:        approvalStore,
		Alerts:           alertStore,
		Keys:             keys,
		JobKey:           jobKey,
		ScriptKey:        scriptKey,
		Scripts:          &scripts.Pipeline{Store: scriptStore, Key: scriptKey},
		Objects:          objects,
		DownloadTTL:      downloadTTL,
		ArtifactMaxBytes: d.ArtifactMaxBytes,
		Log:              log,
		Registry:         registry,
		Sec:              d.Security,
		Clock:            clock,
		EmbedKeys:        d.EmbedKeys,
		EmbedRing:        d.EmbedRing,
		EmbedJTI:         d.EmbedJTI,
		EmbedMintIssuers: append([]string(nil), d.EmbedIssuers...),
		PortalIssuers:    append([]string(nil), d.PortalIssuers...),
		PortalFrames:     append([]string(nil), d.PortalFrameAncestors...),
		EmbedLimiter:     embed.NewLimiter(d.EmbedLimits),
		LoginLimits:      localauth.NormalizeLimits(d.LoginLimits),
		QuotaLimits:      quota.Normalize(d.Quota),
		EmbedAuditor:     d.EmbedAuditor,
		EmbedNBFLeeway:   embed.NormalizeNBFLeeway(d.EmbedNBFLeeway),
		TLSMaterials:     d.TLSMaterials,
	}
	// Dedicated limiter: do not share embed's IP/principal counters.
	s.LoginLimiter = embed.NewLimiter(embed.Limits{
		Window:            s.LoginLimits.Window,
		ExchangeIP:        -1,
		ExchangePrincipal: -1,
		MintPrincipal:     -1,
	})
	if d.PlatformAdmins != nil {
		s.PlatformAdmins = append([]authz.PrincipalRef(nil), d.PlatformAdmins...)
	} else {
		s.PlatformAdmins = authz.ParsePlatformAdmins(os.Getenv(authz.EnvPlatformAdmins), os.Getenv(authz.EnvPlatformAdmin))
	}
	s.Machines = d.Machines
	if s.Machines == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.Machines = machine.NewPostgres(p)
		} else {
			s.Machines = machine.NewMemory()
		}
	}
	s.MachineConsumers = d.MachineConsumers
	s.MachineLimiter = embed.NewLimiter(embed.Limits{
		Window:            time.Minute,
		ExchangeIP:        -1,
		ExchangePrincipal: -1,
		MintPrincipal:     -1,
	})
	s.Quota = d.QuotaStore
	if pool, ok := d.DB.(*postgres.Pool); ok {
		shared := quota.NewPostgres(pool)
		if s.Quota == nil {
			s.Quota = shared
		}
		s.EmbedLimiter.UseShared(shared)
		s.LoginLimiter.UseShared(shared)
		s.MachineLimiter.UseShared(shared)
	}
	if s.Quota == nil {
		s.Quota = quota.NewMemory()
	}
	if p, ok := d.DB.(*postgres.Pool); ok {
		s.MFA = mfa.NewPostgres(p)
		s.OIDC = oidc.NewClient(d.OIDC, oidc.NewPostgres(p))
	} else {
		s.MFA = mfa.NewMemory()
		s.OIDC = oidc.NewClient(d.OIDC, oidc.NewMemory())
	}
	if len(d.MFAKey) == 32 {
		s.MFAKey = append([]byte(nil), d.MFAKey...)
	}
	s.SCIMSettings = d.SCIM
	s.SCIMDir = d.SCIMDir
	if s.SCIMDir == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.SCIMDir = scim.NewPostgres(p)
		} else {
			s.SCIMDir = scim.NewMemory()
		}
	}
	s.Lockouts = d.Lockouts
	if s.Lockouts == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.Lockouts = lockout.NewPostgres(p)
		} else {
			s.Lockouts = lockout.NewMemory()
		}
	}
	s.LockoutMax = d.LockoutMaxFailures
	if s.LockoutMax == 0 {
		s.LockoutMax = lockout.DefaultMaxFailures
	}
	if s.LockoutMax < lockout.MinMaxFailures || s.LockoutMax > lockout.MaxMaxFailures {
		s.LockoutMax = 0
	}
	if !s.EmbedKeys.Ready() {
		if loaded, err := embed.LoadMaterial(); err == nil {
			s.EmbedKeys = loaded
		}
		// Production LoadMaterial fails closed when the key is missing.
		// Do not mint a boot-only ephemeral key here (ADV-006).
	}
	if s.EmbedRing == nil {
		var store embed.KeyStore
		if p, ok := d.DB.(*postgres.Pool); ok {
			store = embed.NewPostgresKeys(p)
		}
		s.EmbedRing = embed.NewRing(s.EmbedKeys, store)
		_ = s.EmbedRing.Refresh(context.Background(), time.Now().UTC())
	}
	if s.EmbedJTI == nil {
		if p, ok := d.DB.(*postgres.Pool); ok {
			s.EmbedJTI = embed.NewPostgresJTI(p)
		} else {
			s.EmbedJTI = embed.NewMemoryJTI()
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
			core.SetRoute(r, routePattern(mux, r))
			w.Header().Set("Allow", allow)
			WriteProblem(w, r, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed", rec)
			return
		}
		if !hasExactRoute(mux, r) {
			core.SetRoute(r, "unmatched")
			WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested path does not exist.")
			return
		}
		core.SetRoute(r, routePattern(mux, r))
		mux.ServeHTTP(w, r)
	})

	unshared := unsharedBackends([]namedBackend{
		{"session", sessions},
		{"workflow", workflows},
		{"jti", s.EmbedJTI},
		{"lockout", s.Lockouts},
		{"vault", vaultStore},
		{"identity", s.Store},
		{"isolation", s.Scoped},
		{"machine", s.Machines},
		{"mfa", s.MFA},
		{"scim", s.SCIMDir},
		{"bootstrap", s.Bootstrap},
		{"webhook", s.Hooks},
		{"schedule", s.Schedules},
		{"ops", s.Ops},
		{"approval", s.Approvals},
		{"alert", s.Alerts},
		{"script", scriptStore},
		{"oidc", oidcBackend(s.OIDC)},
		{"embed-keys", embedKeyBackend(s.EmbedRing)},
	}, d.ArtifactBackend)
	if core.QuotaUnshared(s.Quota) {
		unshared = append(unshared, "rate")
	}
	if !s.LoginLimiter.Shared() {
		unshared = append(unshared, "login-rate")
	}
	if !s.EmbedLimiter.Shared() {
		unshared = append(unshared, "embed-rate")
	}
	if !s.MachineLimiter.Shared() {
		unshared = append(unshared, "machine-rate")
	}
	return &API{
		Handler:    core.WithRequestID(core.WithSecureHeaders(s.Sec, core.WithObserve(log, registry, core.WithRecover(log, core.WithBodyLimit(s.WithOriginPolicy(router)))))),
		srv:        s,
		replicaErr: ha.RefuseUnshared(d.Replicas, unshared),
		unshared:   unshared,
	}
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
