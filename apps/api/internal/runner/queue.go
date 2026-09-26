package runner

import (
	"context"
	"errors"
	"fmt"
	"strings"
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
type Job struct {
	Token     string
	Binding   wfstore.JobBinding
	Job       wfstore.ExecutionJob
	Step      wfstore.ExecutionStep
	Execution wfstore.Execution
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
	return out, nil
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
		Token:     token,
		Binding:   parsed,
		Job:       res.Job,
		Step:      res.Step,
		Execution: res.Execution,
	}, nil
}

func (q *StoreQueue) Heartbeat(ctx context.Context, ws Workspace, job Job) error {
	scope, err := scopeFor(ws)
	if err != nil {
		return err
	}
	_, err = q.Workflows.HeartbeatJob(ctx, scope, q.now(), action(q, job))
	return err
}

func (q *StoreQueue) Complete(ctx context.Context, ws Workspace, job Job, output map[string]any) error {
	scope, err := scopeFor(ws)
	if err != nil {
		return err
	}
	in := action(q, job)
	in.Output = output
	_, err = q.Workflows.CompleteJob(ctx, scope, q.now(), in)
	return err
}

func (q *StoreQueue) Fail(ctx context.Context, ws Workspace, job Job, failure map[string]any) error {
	scope, err := scopeFor(ws)
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
	scope, err := scopeFor(ws)
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
	}
}

func scopeFor(ws Workspace) (isolation.Scope, error) {
	if strings.TrimSpace(ws.TenantID) != "" && strings.TrimSpace(ws.WorkbenchKey) != "" {
		return isolation.AuthorizeTenancy(ws.ID, ws.ActorID, ws.TenantID, ws.WorkbenchKey)
	}
	return isolation.Authorize(ws.ID, ws.ActorID)
}
