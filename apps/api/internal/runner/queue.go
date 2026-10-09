package runner

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Workspace is one membership the runner may claim.
type Workspace struct {
	ID           string
	TenantID     string
	WorkbenchKey string
	ActorID      string
	Permissions  []string
}

// Job is one claimed step plus the HMAC ticket minted for it.
// Inputs and SkippedInputs are the wired ports resolved at claim.
type Job struct {
	Token         string
	Binding       wfstore.JobBinding
	Job           wfstore.ExecutionJob
	Step          wfstore.ExecutionStep
	Execution     wfstore.Execution
	Inputs        map[string]any
	SkippedInputs []wfstore.SkippedInput
}

// Queue is the durable claim/fence surface. Production uses StoreQueue.
type Queue interface {
	Workspaces(ctx context.Context) ([]Workspace, error)
	Claim(ctx context.Context, ws Workspace) (*Job, error)
	Heartbeat(ctx context.Context, ws Workspace, job Job) error
	Complete(ctx context.Context, ws Workspace, job Job, output map[string]any) error
	Fail(ctx context.Context, ws Workspace, job Job, failure map[string]any) error
	Park(ctx context.Context, ws Workspace, job Job, until time.Time) error
}

// StoreQueue claims through workspace stores. It mints and re-parses an
// HMAC job ticket before the caller may dispatch. Fixed, when non-nil,
// skips identity lookup (tests). A nil Fixed list resolves the runner
// principal without upserting.
type StoreQueue struct {
	Workflows wfstore.Store
	Identity  identity.Store
	JobKey    []byte
	WorkerID  string
	UserID    string
	Issuer    string
	Subject   string
	Lease     time.Duration
	Now       func() time.Time
	Fixed     []Workspace

	bindingMu sync.Mutex
	binding   BindingView
	bindingOK bool
}

// BindingView is the runner principal's workspace membership.
// Claimable counts memberships that grant workflow.execute.
// Memberships counts every membership returned for that principal.
type BindingView struct {
	Memberships int
	Claimable   int
}

func (q *StoreQueue) now() time.Time {
	if q != nil && q.Now != nil {
		return q.Now().UTC()
	}
	return time.Now().UTC()
}

func (q *StoreQueue) Workspaces(ctx context.Context) ([]Workspace, error) {
	if q.Fixed != nil {
		out := make([]Workspace, len(q.Fixed))
		copy(out, q.Fixed)
		q.setBinding(BindingView{Memberships: len(out), Claimable: len(out)})
		return out, nil
	}
	if q.Identity == nil {
		return nil, fmt.Errorf("runner principal was not found")
	}
	user, err := q.lookupUser(ctx)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(strings.TrimSpace(user.Status), "active") {
		return nil, fmt.Errorf("runner principal was not found")
	}
	memberships, err := q.Identity.ListWorkspacesForUser(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	out := make([]Workspace, 0, len(memberships))
	for _, item := range memberships {
		if !strings.EqualFold(item.Workspace.Status, "active") || !strings.EqualFold(item.Tenant.Status, "active") {
			continue
		}
		if !authz.Allows(item.Permissions, authz.PermWorkflowExecute) {
			continue
		}
		out = append(out, Workspace{
			ID:           item.Workspace.ID,
			TenantID:     item.Tenant.ID,
			WorkbenchKey: item.Workspace.WorkbenchKey,
			ActorID:      user.ID,
			Permissions:  append([]string(nil), item.Permissions...),
		})
	}
	q.setBinding(BindingView{Memberships: len(memberships), Claimable: len(out)})
	return out, nil
}

func (q *StoreQueue) setBinding(view BindingView) {
	q.bindingMu.Lock()
	q.binding = view
	q.bindingOK = true
	q.bindingMu.Unlock()
}

// BindingView returns the counts from the latest Workspaces call.
func (q *StoreQueue) BindingView() (BindingView, bool) {
	q.bindingMu.Lock()
	defer q.bindingMu.Unlock()
	return q.binding, q.bindingOK
}

func (q *StoreQueue) lookupUser(ctx context.Context) (identity.User, error) {
	if id := strings.TrimSpace(q.UserID); id != "" {
		user, err := q.Identity.GetUser(ctx, id)
		if errors.Is(err, identity.ErrNotFound) {
			return identity.User{}, fmt.Errorf("runner principal was not found")
		}
		return user, err
	}
	user, err := q.Identity.FindUser(ctx, q.Issuer, q.Subject)
	if errors.Is(err, identity.ErrNotFound) || errors.Is(err, identity.ErrInvalid) {
		return identity.User{}, fmt.Errorf("runner principal was not found")
	}
	return user, err
}

func (q *StoreQueue) Claim(ctx context.Context, ws Workspace) (*Job, error) {
	scope, err := scopeFor(ws)
	if err != nil {
		return nil, err
	}
	res, err := q.Workflows.ClaimJob(ctx, scope, q.now(), wfstore.ClaimInput{
		WorkerID: q.WorkerID,
		Lease:    q.Lease,
	})
	if errors.Is(err, wfstore.ErrEmptyClaim) {
		return nil, nil
	}
	if err != nil {
		observability.NoteLeaseClaim(ctx, "error", 0)
		return nil, err
	}
	token, err := wfstore.SignJobTicket(q.JobKey, res.Binding)
	if err != nil {
		return nil, err
	}
	parsed, err := wfstore.ParseJobTicket(q.JobKey, token)
	if err != nil {
		return nil, err
	}
	return &Job{
		Token:         token,
		Binding:       parsed,
		Job:           res.Job,
		Step:          res.Step,
		Execution:     res.Execution,
		Inputs:        res.Inputs,
		SkippedInputs: res.SkippedInputs,
	}, nil
}

func (q *StoreQueue) Heartbeat(ctx context.Context, ws Workspace, job Job) error {
	scope, err := scopeForJob(ws, job.Execution)
	if err != nil {
		return err
	}
	_, err = q.Workflows.HeartbeatJob(ctx, scope, q.now(), action(q, job))
	return err
}

func (q *StoreQueue) Complete(ctx context.Context, ws Workspace, job Job, output map[string]any) error {
	scope, err := scopeForJob(ws, job.Execution)
	if err != nil {
		return err
	}
	in := action(q, job)
	in.Output = output
	_, err = q.Workflows.CompleteJob(ctx, scope, q.now(), in)
	return err
}

func (q *StoreQueue) Release(ctx context.Context, ws Workspace, job Job) (wfstore.DispatchResult, error) {
	scope, err := scopeForJob(ws, job.Execution)
	if err != nil {
		return wfstore.DispatchResult{}, err
	}
	in := action(q, job)
	// This release is only the transient approval rebuild path. Other
	// worker releases go through ReleaseJob with the flag left false.
	in.ApprovalTransientRetry = true
	return q.Workflows.ReleaseJob(ctx, scope, q.now(), in)
}

func (q *StoreQueue) Fail(ctx context.Context, ws Workspace, job Job, failure map[string]any) error {
	scope, err := scopeForJob(ws, job.Execution)
	if err != nil {
		return err
	}
	in := action(q, job)
	in.Error = failure
	_, err = q.Workflows.FailJob(ctx, scope, q.now(), in)
	return err
}

func (q *StoreQueue) Park(ctx context.Context, ws Workspace, job Job, until time.Time) error {
	return q.park(ctx, ws, job, until, nil)
}

// ParkApproval parks a gate and inserts its approval in that same transaction.
// The approval expires_at is until, the wait deadline.
func (q *StoreQueue) ParkApproval(ctx context.Context, ws Workspace, job Job, until time.Time, in approval.CreateInput) error {
	return q.park(ctx, ws, job, until, &in)
}

func (q *StoreQueue) park(ctx context.Context, ws Workspace, job Job, until time.Time, seed *approval.CreateInput) error {
	scope, err := scopeForJob(ws, job.Execution)
	if err != nil {
		return err
	}
	_, err = q.Workflows.WaitJob(ctx, scope, q.now(), wfstore.WaitJobInput{
		JobID:       job.Job.ID,
		AvailableAt: until,
		Approval:    parkedApproval(seed),
	})
	return err
}

func action(q *StoreQueue, job Job) wfstore.JobActionInput {
	return wfstore.JobActionInput{
		JobID:        job.Job.ID,
		WorkerID:     q.WorkerID,
		FencingToken: job.Job.FencingToken,
		Lease:        q.Lease,
	}
}

func parkedApproval(in *approval.CreateInput) *wfstore.ParkedApproval {
	if in == nil {
		return nil
	}
	req := in.Requirement
	return &wfstore.ParkedApproval{
		WorkflowID:        in.WorkflowID,
		WorkflowVersionID: in.WorkflowVersionID,
		WorkflowDigest:    in.WorkflowDigest,
		ExecutionID:       in.ExecutionID,
		RequestedBy:       in.RequestedBy,
		NodeID:            req.NodeID,
		NodeName:          req.NodeName,
		Operation:         req.Operation,
		ApproverRole:      req.ApproverRole,
		TargetKind:        req.TargetKind,
		TargetID:          req.TargetID,
		TargetVersionID:   req.TargetVersionID,
		TargetDigest:      req.TargetDigest,
		PolicyResourceID:  req.PolicyResourceID,
		PolicyVersionID:   req.PolicyVersionID,
		PolicyDigest:      req.PolicyDigest,
		PolicyRevision:    req.PolicyRevision,
		ApproversDigest:   req.ApproversDigest,
		ApproverUsers:     req.ApproverUsers,
		ApproverGroups:    req.ApproverGroups,
	}
}

// scopeFor is the workspace scope for a claim, before any run is known.
// An empty actor is not treated as system. That inference is what #628
// removes. Callers that have the run use scopeForJob.
func scopeFor(ws Workspace) (isolation.Scope, error) {
	if strings.TrimSpace(ws.ActorID) == "" {
		return isolation.Scope{}, isolation.ErrNoActor
	}
	return scopeForActor(ws)
}

// scopeForJob scopes work on a claimed run. A worker actor is used as
// itself. An empty worker actor is not assumed to be system: schedule,
// webhook, and resync runs get a system scope, and anything else is refused.
func scopeForJob(ws Workspace, exec wfstore.Execution) (isolation.Scope, error) {
	if strings.TrimSpace(ws.ActorID) != "" {
		return scopeForActor(ws)
	}
	if wfstore.IsSystemTrigger(exec) {
		return systemScope(ws)
	}
	return isolation.Scope{}, isolation.ErrNoActor
}

func scopeForActor(ws Workspace) (isolation.Scope, error) {
	if strings.TrimSpace(ws.TenantID) != "" && strings.TrimSpace(ws.WorkbenchKey) != "" {
		return isolation.AuthorizeTenancy(ws.ID, ws.ActorID, ws.TenantID, ws.WorkbenchKey)
	}
	return isolation.Authorize(ws.ID, ws.ActorID)
}

func systemScope(ws Workspace) (isolation.Scope, error) {
	if strings.TrimSpace(ws.TenantID) != "" && strings.TrimSpace(ws.WorkbenchKey) != "" {
		return isolation.AuthorizeSystemTenancy(ws.ID, ws.TenantID, ws.WorkbenchKey)
	}
	return isolation.AuthorizeSystem(ws.ID)
}

// Stored trigger types that are allowed to run with no requester.
// manual and api are not in this set.
const (
	triggerSchedule = "schedule"
	triggerWebhook  = "webhook"
	triggerResync   = "resync"
)
