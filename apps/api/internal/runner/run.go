package runner

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Config is the production claim loop.
type Config struct {
	WorkerID     string
	PollInterval time.Duration
	// DrainTimeout is how long an in-flight claim may finish after
	// the poll context is cancelled (SIGTERM). Zero uses 30s. The
	// budget does not cap a claim while the process is still running.
	DrainTimeout time.Duration
	Log          *slog.Logger
}

// Runner claims jobs and dispatches them through Dispatcher.
type Runner struct {
	queue Queue
	disp  *Dispatcher
	cfg   Config
	log   *slog.Logger
	now   func() time.Time
}

// NewRunner returns a poll loop. now defaults to time.Now.
func NewRunner(queue Queue, disp *Dispatcher, cfg Config) *Runner {
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
		queue: queue,
		disp:  disp,
		cfg:   cfg,
		log:   log,
		now:   func() time.Time { return time.Now().UTC() },
	}
}

// Run polls until ctx is cancelled. Cancellation finishes the in-flight
// claim (up to DrainTimeout) and does not start another. A clean drain
// returns nil. A claim that is still running when the budget ends is
// cancelled; lease recovery and the fencing token reject a stale completion.
func (r *Runner) Run(ctx context.Context) error {
	r.log.Info("production runner polling for jobs", "worker_id", r.cfg.WorkerID, "interval", r.cfg.PollInterval.String())
	ticker := time.NewTicker(r.cfg.PollInterval)
	defer ticker.Stop()
	if ctx.Err() == nil {
		r.pollPass(ctx)
	}
	for {
		select {
		case <-ctx.Done():
			r.log.Info("production runner drained")
			return nil
		case <-ticker.C:
			if ctx.Err() != nil {
				r.log.Info("production runner drained")
				return nil
			}
			r.pollPass(ctx)
		}
	}
}

// pollPass claims once. The job context outlives parent cancellation
// until the drain budget so SIGTERM does not abort the current job.
// A pass that starts after cancellation does not claim.
func (r *Runner) pollPass(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	jobCtx, cancel := r.claimContext(ctx)
	defer cancel()
	if _, err := r.PollOnce(jobCtx); err != nil && jobCtx.Err() == nil {
		r.log.Warn("production runner poll", "error", safeErr(err))
	}
}

// claimContext is cancelled when the caller finishes the pass, or when
// parent is cancelled and the drain budget has elapsed.
func (r *Runner) claimContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	stop := make(chan struct{})
	var once sync.Once
	finish := func() {
		once.Do(func() {
			close(stop)
			cancel()
		})
	}
	go func() {
		select {
		case <-parent.Done():
			timer := time.NewTimer(r.drainBudget())
			select {
			case <-stop:
				timer.Stop()
			case <-timer.C:
				cancel()
			}
		case <-stop:
		}
	}()
	return ctx, finish
}

func (r *Runner) drainBudget() time.Duration {
	if r.cfg.DrainTimeout > 0 {
		return r.cfg.DrainTimeout
	}
	return 30 * time.Second
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

// PollOnce claims at most one job per workspace.
func (r *Runner) PollOnce(ctx context.Context) (int, error) {
	items, err := r.queue.Workspaces(ctx)
	if err != nil {
		return 0, err
	}
	claimed := 0
	for _, ws := range items {
		ok, err := r.claimOne(ctx, ws)
		if err != nil {
			return claimed, err
		}
		if ok {
			claimed++
		}
	}
	return claimed, nil
}

func (r *Runner) claimOne(ctx context.Context, ws Workspace) (bool, error) {
	job, err := r.queue.Claim(ctx, ws)
	if err != nil {
		return false, err
	}
	if job == nil {
		return false, nil
	}
	ctx, span := observability.Continue(ctx, job.Job.TraceParent, job.Job.TraceState, "runner.job")
	defer span.End()
	if job.Job.Status == wfstore.JobWaiting || job.Step.NodeType == "flow.approval" {
		until, decision := approvalDeadline(job.Step, r.now())
		if decision.Fail {
			if err := r.queue.Fail(ctx, ws, *job, decision.Error); err != nil {
				return true, err
			}
			r.log.Info("production runner failed job", "job_id", job.Job.ID, "node_type", job.Step.NodeType, "code", decision.Error["code"])
			return true, nil
		}
		if err := r.queue.Park(ctx, ws, *job, until); err != nil {
			return true, err
		}
		r.log.Info("production runner parked job", "job_id", job.Job.ID, "node_type", job.Step.NodeType)
		return true, nil
	}
	if err := wfstore.AuthorizeJobBinding(job.Binding, ws.ID, job.Execution.WorkflowVersionID, job.Execution.WorkflowDigest, r.now()); err != nil {
		decision := classifyBinding(job.Binding, err)
		r.log.Warn("production runner rejected binding", "job_id", job.Job.ID, "node_type", job.Step.NodeType, "code", decision.Error["code"])
		if failErr := r.queue.Fail(ctx, ws, *job, decision.Error); failErr != nil {
			return true, failErr
		}
		return true, nil
	}
	if err := r.queue.Heartbeat(ctx, ws, *job); err != nil {
		return true, err
	}
	scope, err := scopeFor(ws)
	if err != nil {
		return true, err
	}
	decision := r.disp.Execute(ctx, scope, ws.Permissions, *job)
	if decision.Skip {
		r.log.Info("production runner skipped job", "job_id", job.Job.ID, "node_type", job.Step.NodeType)
		return true, nil
	}
	if decision.Fail {
		if err := r.queue.Fail(ctx, ws, *job, decision.Error); err != nil {
			return true, err
		}
		r.log.Info("production runner failed job", "job_id", job.Job.ID, "node_type", job.Step.NodeType, "code", decision.Error["code"])
		return true, nil
	}
	if err := r.queue.Complete(ctx, ws, *job, decision.Output); err != nil {
		return true, err
	}
	r.log.Info("production runner completed job", "job_id", job.Job.ID, "node_type", job.Step.NodeType)
	return true, nil
}

func approvalDeadline(step wfstore.ExecutionStep, now time.Time) (time.Time, Decision) {
	if step.NodeType != "flow.approval" {
		return time.Time{}, Decision{}
	}
	res, errs := workflow.Evaluate(step.NodeType, step.Input, map[string]any{})
	if len(errs) > 0 {
		code := errs[0].Code
		if code == "" {
			code = "eval-failed"
		}
		return time.Time{}, fail(code, errs[0].Message)
	}
	secs := 0
	if res != nil {
		secs = asInt(res.Audit["expiresSeconds"])
	}
	if secs <= 0 {
		return time.Time{}, fail(CodeUnsupported, "Production runner cannot park an approval without an expiry.")
	}
	return now.Add(time.Duration(secs) * time.Second), Decision{}
}

func safeErr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
