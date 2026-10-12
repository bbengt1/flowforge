package fixturesuite

import (
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/runner"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Driver drives a started execution to a terminal (or parked) state.
type Driver interface {
	Name() string
	// Drive runs queued jobs for the workspace until none are left.
	Drive(t *testing.T, w *Workspace) error
	// DriveOnce drains once without moving the clock (drive-until-waiting).
	DriveOnce(t *testing.T, w *Workspace) error
	// ClaimAndDie claims one job and abandons it with its lease held: a
	// worker killed mid-job (S4 lease loss). It reports whether a job was
	// claimed.
	ClaimAndDie(t *testing.T, w *Workspace) (bool, error)
}

func drivers() map[string]Driver {
	return map[string]Driver{"compose": composeDriver{}, "runner": runnerDriver{}}
}

// composeDriver is the compose worker: localworker over HTTP against the
// in-process API, bound through the same startup path compose uses.
type composeDriver struct{}

func (composeDriver) Name() string { return "compose" }

// DriveOnce is Drive: the compose worker never moves the clock.
func (c composeDriver) DriveOnce(t *testing.T, w *Workspace) error { return c.Drive(t, w) }

func (c composeDriver) Drive(t *testing.T, w *Workspace) error {
	t.Helper()
	client, id, done, err := c.client(w)
	if err != nil {
		return err
	}
	defer done()
	_, err = localworker.NewRunner(client, localworker.Config{WorkerID: id}).Drain(w.env.ctx)
	return err
}

// client binds the compose worker and returns its HTTP client against
// an in-process server (done closes it).
func (composeDriver) client(w *Workspace) (*localworker.HTTP, string, func(), error) {
	ref := authz.PrincipalRef{Issuer: localworker.DefaultIssuer, Subject: fmt.Sprintf("%s-%s", localworker.DefaultSubject, w.Tenant.Slug)}
	res, err := localseed.EnsureWorkerIn(w.env.ctx, localseed.WorkerInput{Store: identity.NewPostgres(w.env.app), Worker: ref}, w.Tenant.Slug, w.WS.WorkbenchKey)
	if err != nil || res.Skipped != "" || res.UserID == "" {
		return nil, "", nil, fmt.Errorf("bind compose worker: %+v %v", res, err)
	}
	srv := httptest.NewServer(w.env.handler())
	id := fmt.Sprintf("fixturesuite-%s-g%d", w.Tenant.Slug, w.gen)
	client := localworker.NewHTTP(localworker.HTTPConfig{
		BaseURL: srv.URL, Issuer: ref.Issuer, Subject: ref.Subject, WorkerID: id, Lease: 30 * time.Second,
	})
	return client, id, srv.Close, nil
}

// ClaimAndDie claims over HTTP as the compose worker and never reports.
func (c composeDriver) ClaimAndDie(t *testing.T, w *Workspace) (bool, error) {
	t.Helper()
	client, _, done, err := c.client(w)
	if err != nil {
		return false, err
	}
	defer done()
	claim, err := client.Claim(w.env.ctx, w.Tenant.Slug, w.WS.WorkbenchKey)
	return claim != nil, err
}

// runnerDriver drives the production runner (internal/runner) in-process
// with the suite's fake clock (runner.Config.Now, #656). After each drain
// it advances the clock past any flow.delay / approval deadline and runs
// the API's lease/approval-expiry sweep (TickRecover), then drains again,
// until a round claims nothing.
type runnerDriver struct{}

func (runnerDriver) Name() string { return "runner" }

// runnerStep is how far each idle round advances the fake clock. It is
// longer than any delay or approval expiry the fixtures use.
const (
	runnerStep   = 25 * time.Hour
	runnerRounds = 8
)

func (d runnerDriver) DriveOnce(t *testing.T, w *Workspace) error {
	t.Helper()
	r, err := d.newRunner(w)
	if err != nil {
		return err
	}
	_, err = r.Drain(w.env.ctx)
	return err
}

func (d runnerDriver) Drive(t *testing.T, w *Workspace) error {
	t.Helper()
	e := w.env
	r, err := d.newRunner(w)
	if err != nil {
		return err
	}
	if _, err := r.Drain(e.ctx); err != nil {
		return err
	}
	for i := 0; i < runnerRounds; i++ {
		e.Advance(runnerStep)
		if err := e.api.TickRecover(e.ctx); err != nil {
			return fmt.Errorf("tick recover: %w", err)
		}
		n, err := r.Drain(e.ctx)
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
	}
	return fmt.Errorf("runner still claiming after %d clock rounds", runnerRounds)
}

// ClaimAndDie claims through the production runner's queue and never
// reports back, as if the runner process were killed mid-job.
func (d runnerDriver) ClaimAndDie(t *testing.T, w *Workspace) (bool, error) {
	t.Helper()
	_, queue, err := d.build(w)
	if err != nil {
		return false, err
	}
	list, err := queue.Workspaces(w.env.ctx)
	if err != nil {
		return false, err
	}
	for _, ws := range list {
		job, err := queue.Claim(w.env.ctx, ws)
		if err != nil {
			return false, err
		}
		if job != nil {
			return true, nil
		}
	}
	return false, nil
}

// newRunner builds a fresh production runner for the workspace. Its
// worker id carries w.gen, so kill-runner/new-runner gets a new identity.
func (d runnerDriver) newRunner(w *Workspace) (*runner.Runner, error) {
	r, _, err := d.build(w)
	return r, err
}

func (runnerDriver) build(w *Workspace) (*runner.Runner, *runner.StoreQueue, error) {
	e := w.env
	ref := authz.PrincipalRef{Issuer: localworker.DefaultIssuer, Subject: fmt.Sprintf("fixturesuite-runner-%s", w.Tenant.Slug)}
	res, err := localseed.EnsureWorkerIn(e.ctx, localseed.WorkerInput{Store: identity.NewPostgres(e.app), Worker: ref}, w.Tenant.Slug, w.WS.WorkbenchKey)
	if err != nil || res.Skipped != "" || res.UserID == "" {
		return nil, nil, fmt.Errorf("bind runner principal: %+v %v", res, err)
	}
	id := fmt.Sprintf("fixturesuite-runner-%s-g%d", w.Tenant.Slug, w.gen)
	queue := &runner.StoreQueue{
		Workflows: wfstore.NewPostgres(e.app),
		Identity:  identity.NewPostgres(e.app),
		JobKey:    e.jobKey,
		WorkerID:  id,
		UserID:    res.UserID,
		Issuer:    ref.Issuer,
		Subject:   ref.Subject,
		Lease:     30 * time.Second,
	}
	disp := &runner.Dispatcher{
		Ops:     opsconfig.NewPostgres(e.app),
		Scripts: scripts.NewPostgres(e.app),
	}
	return runner.NewRunner(queue, disp, runner.Config{
		WorkerID: id,
		Now:      e.Now,
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}), queue, nil
}
