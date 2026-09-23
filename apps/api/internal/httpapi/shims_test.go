package httpapi

import (
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/workflowhttp"
)

const headerDisplayName = core.HeaderDisplayName
const headerIssuer = core.HeaderIssuer
const headerSubject = core.HeaderSubject

type currentWorkspaceResponse = core.CurrentWorkspaceResponse
type evaluateResponse = approvalhttp.EvaluateResponse

const headerTenantSlug = core.HeaderTenantSlug
const headerWorkbenchKey = core.HeaderWorkbenchKey

type listResponse[T any] = core.ListResponse[T]
type workflowDetailResponse = workflowhttp.WorkflowDetailResponse
type sessionResponse = core.SessionResponse

const invalidCredentialsDetail = core.InvalidCredentialsDetail

type claimJobResponse = workflowhttp.ClaimJobResponse

var validRequestID = core.ValidRequestID

type executionResponse = workflowhttp.ExecutionResponse
type mfaStatus = core.MfaStatus

var latestRetryCandidate = workflowhttp.LatestRetryCandidate

type recoverJobsResponse = workflowhttp.RecoverJobsResponse
type retryResponse = workflowhttp.RetryResponse
type exportResponse = workflowhttp.ExportResponse
type publishResponse = workflowhttp.PublishResponse
type embedExchangeResponse = core.EmbedExchangeResponse

const headerHostContext = core.HeaderHostContext
const headerHostIssuer = core.HeaderHostIssuer
const headerTenantID = core.HeaderTenantID

var queuedUnclaimedReason = workflowhttp.QueuedUnclaimedReason

const StatusReasonNoWorker = workflowhttp.StatusReasonNoWorker
const DefaultQueuedNoWorkerAfter = workflowhttp.DefaultQueuedNoWorkerAfter

type scheduleDispatchResponse = workflowhttp.ScheduleDispatchResponse
type opsDetailResponse = workflowhttp.OpsDetailResponse
type opsPublishResponse = workflowhttp.OpsPublishResponse
type normalizeResponse = workflowhttp.NormalizeResponse
type validateResponse = workflowhttp.ValidateResponse

var paramKind = rt.ParamKind
var mustOpenAPIYAML = core.MustOpenAPIYAML

const problemTypePrefix = core.ProblemTypePrefix

var withObserve = core.WithObserve
var withRecover = core.WithRecover
var withRequestID = core.WithRequestID
var writeJSON = core.WriteJSON

type pageResponse[T any] = core.PageResponse[T]

const changePasswordReuseDetail = core.ChangePasswordReuseDetail

type downloadGrantResponse = workflowhttp.DownloadGrantResponse
type retentionPurgeResponse = workflowhttp.RetentionPurgeResponse

const headerWorkspaceID = core.HeaderWorkspaceID

type permissionMatrixResponse = core.PermissionMatrixResponse
