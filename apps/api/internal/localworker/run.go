package localworker

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Config is the compose/local runner loop.
type Config struct {
	WorkerID     string
	PollInterval time.Duration
	Log          *slog.Logger
}

// Runner claims and completes jobs through the public worker API.
type Runner struct {
	api  API
	cfg  Config
	log  *slog.Logger
	now  func() time.Time
	auth func(binding wfstore.JobBinding, workspaceID string, now time.Time) error
}

// NewRunner returns a poll loop. auth defaults to wfstore.AuthorizeJobBinding.
func NewRunner(api API, cfg Config) *Runner {
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	interval := cfg.PollInterval
	if interval <= 0 {
		interval = time.Second
	}
	cfg.PollInterval = interval
	return &Runner{
		api: api,
		cfg: cfg,
		log: log,
		now: func() time.Time { return time.Now().UTC() },
		auth: func(binding wfstore.JobBinding, workspaceID string, now time.Time) error {
			return wfstore.AuthorizeJobBinding(binding, workspaceID, "", "", now)
		},
	}
}

// Run waits for API readiness, then polls until ctx is cancelled.
func (r *Runner) Run(ctx context.Context) error {
	if err := r.waitReady(ctx); err != nil {
		return err
	}
	r.log.Info("local worker polling for jobs", "worker_id", r.cfg.WorkerID, "interval", r.cfg.PollInterval.String())
	ticker := time.NewTicker(r.cfg.PollInterval)
	defer ticker.Stop()
	if _, err := r.PollOnce(ctx); err != nil && ctx.Err() == nil {
		r.log.Warn("local worker poll", "error", err)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if _, err := r.PollOnce(ctx); err != nil && ctx.Err() == nil {
				r.log.Warn("local worker poll", "error", err)
			}
		}
	}
}

// Drain claims until two consecutive empty passes. Used by tests.
func (r *Runner) Drain(ctx context.Context) (int, error) {
	n := 0
	idle := 0
	for idle < 2 {
		if err := ctx.Err(); err != nil {
			return n, err
		}
		claimed, err := r.PollOnce(ctx)
		if err != nil {
			return n, err
		}
		if claimed == 0 {
			idle++
			continue
		}
		idle = 0
		n += claimed
	}
	return n, nil
}

// PollOnce lists memberships and claims at most one job per workspace.
func (r *Runner) PollOnce(ctx context.Context) (int, error) {
	items, err := r.api.ListMemberships(ctx)
	if err != nil {
		return 0, err
	}
	claimed := 0
	for _, item := range items {
		slug := strings.TrimSpace(item.Tenant.Slug)
		key := strings.TrimSpace(item.Workspace.WorkbenchKey)
		if slug == "" || key == "" {
			continue
		}
		ok, err := r.claimOne(ctx, slug, key, item.Workspace.ID)
		if err != nil {
			return claimed, err
		}
		if ok {
			claimed++
		}
	}
	return claimed, nil
}

func (r *Runner) claimOne(ctx context.Context, tenantSlug, workbenchKey, workspaceID string) (bool, error) {
	claim, err := r.api.Claim(ctx, tenantSlug, workbenchKey)
	if err != nil {
		return false, err
	}
	if claim == nil {
		return false, nil
	}
	if claim.Job.Status == wfstore.JobWaiting || strings.TrimSpace(claim.JobToken) == "" {
		r.log.Info("local worker skipped parked job",
			"job_id", claim.Job.ID,
			"node_type", claim.Step.NodeType,
			"status", claim.Job.Status,
		)
		return true, nil
	}
	if err := r.auth(claim.Binding, firstNonEmpty(workspaceID, claim.Binding.WorkspaceID), r.now()); err != nil {
		r.log.Warn("local worker rejected binding", "job_id", claim.Job.ID, "error", err)
		if failErr := r.api.Fail(ctx, tenantSlug, workbenchKey, *claim, map[string]any{
			"code":    "job-binding-rejected",
			"message": "Worker rejected the authenticated job binding.",
		}); failErr != nil {
			return true, failErr
		}
		return true, nil
	}
	if err := r.api.Heartbeat(ctx, tenantSlug, workbenchKey, *claim); err != nil {
		return true, err
	}
	decision := Decide(claim.Step, claim.Job)
	if decision.Skip {
		r.log.Info("local worker skipped claimed job", "job_id", claim.Job.ID, "reason", decision.Reason)
		return true, nil
	}
	if decision.Fail {
		if err := r.api.Fail(ctx, tenantSlug, workbenchKey, *claim, decision.Error); err != nil {
			return true, err
		}
		r.log.Info("local worker failed job",
			"job_id", claim.Job.ID,
			"node_type", claim.Step.NodeType,
			"code", decision.Error["code"],
		)
		return true, nil
	}
	if err := r.api.Complete(ctx, tenantSlug, workbenchKey, *claim, decision.Output); err != nil {
		return true, err
	}
	r.log.Info("local worker completed job",
		"job_id", claim.Job.ID,
		"execution_id", claim.Execution.ID,
		"node_type", claim.Step.NodeType,
	)
	return true, nil
}

func (r *Runner) waitReady(ctx context.Context) error {
	backoff := 200 * time.Millisecond
	for {
		err := r.api.Ready(ctx)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.log.Info("waiting for API readiness", "error", err)
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
