// Package scripts is the E9 script engine: publish/scan/sign/pin (E9.1),
// isolated short-lived runners (E9.2), typed I/O + recovery (E9.3), and
// artifact revocation + emergency stop (E9.4).
package scripts

import (
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Languages approved for MVP script nodes.
const (
	LanguagePython = "python"
	LanguageGo     = "go"
)

// Node types.
const (
	NodePython = "script.python"
	NodeGo     = "script.go"
)

// Artifact statuses. Drafts are mutable and cannot execute.
const (
	StatusDraft     = "draft"
	StatusPublished = "published"
)

// Scan statuses. Execution requires clean. pending/failed/unsigned fail closed.
const (
	ScanPending  = "pending"
	ScanClean    = "clean"
	ScanFailed   = "failed"
	ScanUnsigned = "unsigned"
)

// Size and resource bounds. Fail closed.
const (
	MaxSourceBytes      = 64 << 10
	MaxEntrypointBytes  = 256
	MinTimeoutSeconds   = 1
	MaxTimeoutSeconds   = 3600
	DefaultTimeout      = 30
	MinMemoryMiB        = 32
	MaxMemoryMiB        = 2048
	MinCPUMillis        = 1
	MaxCPUMillis        = 8000
	MinProcesses        = 1
	MaxProcesses        = 256
	SignaturePrefix     = "hmac-sha256:"
	PackageAPIVersion   = "flowforge/v1"
	PackageKind         = "ScriptPackage"
	EnvScriptSigningKey = "SCRIPT_SIGNING_KEY"

	// Isolated runner identity. Matches deploy/kubernetes/script-runner-*.yaml.
	RunnerUID            = 65532
	RunnerGID            = 65532
	RunnerWorkspacePath  = "/workspace"
	CapabilityDropAll    = "ALL"
	IsolationModeHarness = "harness"
	IsolationModeLive    = "kubernetes"
	GoBinaryPrefix       = "hmac-sha256:"

	// Typed I/O bounds (E9.3). Match core port caps so one node cannot dominate.
	MaxInputBytes  = 16 << 10
	MaxOutputBytes = 16 << 10

	// Retry defaults (E9.3). Mirror E8.3: never blindly re-run.
	DefaultMaxAttempts = 0
	MaxRetryAttempts   = 5
	MaxIdempotencyKey  = 128

	// Short-lived credential handle TTL. Plaintext never leaves the handle.
	DefaultHandleTTL = 60
	MaxHandleTTL     = 300

	RetrySemantics            = "E9.3"
	RetryVerificationContract = "node-declared-idempotent-hook"
	VerificationBehaviorHook  = "declared-hook"

	VerifyAlreadyApplied = "already-applied"
	VerifySafeToRetry    = "safe-to-retry"
	VerifyIndeterminate  = "indeterminate"

	MaxRevokeReasonBytes = 256
	AuditRevoke          = "script.artifact.revoke"
	AuditEmergencyStop   = "script.emergency_stop"
	OutcomeCanceled      = "canceled"
	OutcomeIndeterminate = "indeterminate"
)

// Artifact is an immutable content-addressed script package. JSON never
// includes the package blob, storage locator, or signing key material.
type Artifact struct {
	ID                      string         `json:"id"`
	Language                string         `json:"language"`
	Entrypoint              string         `json:"entrypoint"`
	Digest                  string         `json:"digest"`
	Signature               string         `json:"signature"`
	ScanStatus              string         `json:"scanStatus"`
	Status                  string         `json:"status"`
	RuntimeProfileID        string         `json:"runtimeProfileId,omitempty"`
	RuntimeProfileVersionID string         `json:"runtimeProfileVersionId,omitempty"`
	RuntimeProfileDigest    string         `json:"runtimeProfileDigest,omitempty"`
	SourceBytes             int            `json:"sourceBytes"`
	Metadata                map[string]any `json:"metadata"`
	CreatedBy               string         `json:"createdBy,omitempty"`
	CreatedAt               time.Time      `json:"createdAt"`
	RevokedAt               *time.Time     `json:"revokedAt,omitempty"`
	RevokedBy               string         `json:"revokedBy,omitempty"`
	StorageRef              string         `json:"-"`
	Package                 []byte         `json:"-"`
}

// VersionPin binds one published script artifact to a workflow version node.
type VersionPin struct {
	WorkflowVersionID string `json:"workflowVersionId"`
	NodeID            string `json:"nodeId"`
	NodeType          string `json:"nodeType"`
	ArtifactID        string `json:"artifactId"`
	Digest            string `json:"digest"`
	ScanStatus        string `json:"scanStatus"`
	Signature         string `json:"signature,omitempty"`
	Language          string `json:"language,omitempty"`
	Entrypoint        string `json:"entrypoint,omitempty"`
}

// PublishInput is a dedicated or workflow-node package request.
type PublishInput struct {
	Language                string
	Source                  string
	Entrypoint              string
	RuntimeProfileID        string
	RuntimeProfileVersionID string
	RuntimeProfileDigest    string
	RuntimeProfile          map[string]any
	InputSchema             map[string]any
	OutputSchema            map[string]any
	TimeoutSeconds          int
	MemoryMiB               int
	CPUMillis               int
	Processes               int
	NodeID                  string
	NodeType                string
	WorkflowVersionID       string
	RetryWith               map[string]any
}

// PackagePayload is the canonical bytes hashed into Digest.
type PackagePayload struct {
	APIVersion           string         `json:"apiVersion"`
	Kind                 string         `json:"kind"`
	Language             string         `json:"language"`
	Entrypoint           string         `json:"entrypoint"`
	Source               string         `json:"source"`
	InputSchema          map[string]any `json:"inputSchema,omitempty"`
	OutputSchema         map[string]any `json:"outputSchema,omitempty"`
	RuntimeProfileDigest string         `json:"runtimeProfileDigest,omitempty"`
}

// RequiredPermissions is the FlowForge RBAC set for script execute paths.
func RequiredPermissions() []string {
	return []string{
		authz.PermWorkflowExecute,
		authz.PermScriptRun,
		authz.PermRuntimeProfileUse,
	}
}

// LanguageForNode maps a YAML node type to a runtime language.
func LanguageForNode(nodeType string) string {
	switch nodeType {
	case NodePython:
		return LanguagePython
	case NodeGo:
		return LanguageGo
	default:
		return ""
	}
}

// IsScriptNode reports whether typ is a script engine node.
func IsScriptNode(typ string) bool {
	return typ == NodePython || typ == NodeGo
}
