package core

import (
	"log/slog"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
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
)

// Server is the control-plane state shared by every domain router.
// Fields are exported so domain packages can use them without a
// behavior-changing rewrite of handler bodies. The composition root
// in package httpapi is the only constructor.
type Server struct {
	DB               postgres.Checker
	Store            identity.Store
	Bootstrap        bootstrap.Store
	Scoped           isolation.Store
	Cache            *isolation.Cache
	Sessions         session.Store
	Workflows        wfstore.Store
	Vault            vault.Store
	Hooks            webhook.Store
	Schedules        schedule.Store
	Ops              opsconfig.Store
	Approvals        approval.Store
	Alerts           opsalert.Store
	Keys             vault.Keys
	JobKey           []byte
	ScriptKey        []byte
	Scripts          *scripts.Pipeline
	Objects          artifact.Objects
	DownloadTTL      time.Duration
	ArtifactMaxBytes int
	Log              *slog.Logger
	Registry         *observability.Registry
	Sec              Security
	Clock            func() time.Time
	EmbedKeys        embed.Material
	EmbedRing        *embed.Ring
	EmbedJTI         embed.JTIConsumer
	EmbedMintIssuers []string
	PortalIssuers    []string
	PortalFrames     []string
	PlatformAdmins   []authz.PrincipalRef
	EmbedLimiter     *embed.Limiter
	LoginLimiter     *embed.Limiter
	MachineLimiter   *embed.Limiter
	LoginLimits      localauth.Limits
	Quota            quota.Taker
	QuotaLimits      quota.Limits
	Machines         machine.Store
	MachineConsumers machine.Consumers
	OIDC             *oidc.Client
	MFA              mfa.Store
	MFAKey           []byte
	SCIMSettings     scim.Settings
	SCIMDir          scim.Store
	Lockouts         lockout.Store
	LockoutMax       int
	EmbedAuditor     embed.Auditor
	EmbedNBFLeeway   time.Duration
	TLSMaterials     tlsmaterial.Store
}
