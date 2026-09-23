package httpapi

import (
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

type Server = core.Server
type Security = core.Security
type SessionPolicy = core.SessionPolicy
type Problem = core.Problem
type FieldError = core.FieldError
type Route = rt.Route
type AuthClass = rt.AuthClass
type ProxyClass = rt.ProxyClass

const (
	CodeArtifactMutable       = core.CodeArtifactMutable
	CodeArtifactRevoked       = core.CodeArtifactRevoked
	CodeArtifactScanFailed    = core.CodeArtifactScanFailed
	CodeArtifactUnscanned     = core.CodeArtifactUnscanned
	CodeArtifactUnsigned      = core.CodeArtifactUnsigned
	CodeConflict              = core.CodeConflict
	CodeDependencyUnavailable = core.CodeDependencyUnavailable
	CodeEgressDenied          = core.CodeEgressDenied
	CodeForbidden             = core.CodeForbidden
	CodeImageDenied           = core.CodeImageDenied
	CodeIndeterminate         = core.CodeIndeterminate
	CodeInternalError         = core.CodeInternalError
	CodeInvalidRequest        = core.CodeInvalidRequest
	CodeInvalidWorkflow       = core.CodeInvalidWorkflow
	CodeIsolationDenied       = core.CodeIsolationDenied
	CodeMFARequired           = core.CodeMFARequired
	CodeMetadataDenied        = core.CodeMetadataDenied
	CodeMethodNotAllowed      = core.CodeMethodNotAllowed
	CodeNotFound              = core.CodeNotFound
	CodePackageInstallDenied  = core.CodePackageInstallDenied
	CodeRateLimited           = core.CodeRateLimited
	CodeRequestTooLarge       = core.CodeRequestTooLarge
	CodeResourceLimit         = core.CodeResourceLimit
	CodeRetryDenied           = core.CodeRetryDenied
	CodeUnauthenticated       = core.CodeUnauthenticated
	MaxRequestBody            = core.MaxRequestBody
	RequestIDHeader           = core.RequestIDHeader
	AuthPublic                = rt.AuthPublic
	AuthEmbed                 = rt.AuthEmbed
	AuthAuthenticated         = rt.AuthAuthenticated
	ProxyBrowser              = rt.ProxyBrowser
	ProxyNone                 = rt.ProxyNone
)

var DecodeJSON = core.DecodeJSON
var RenderOpenAPI = rt.RenderOpenAPI
var RenderProxyAllowlist = rt.RenderProxyAllowlist
var RequestIDFromContext = core.RequestIDFromContext
var RouteFromContext = core.RouteFromContext
var WriteForbidden = core.WriteForbidden
var WriteProblem = core.WriteProblem
var WriteProblemErrors = core.WriteProblemErrors
var WriteUnauthenticated = core.WriteUnauthenticated
