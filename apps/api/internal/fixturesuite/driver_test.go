package fixturesuite

import (
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
)

// Driver drives a started execution to a terminal (or parked) state.
type Driver interface {
	Name() string
	// Drive runs queued jobs for the workspace until none are left.
	Drive(t *testing.T, w *Workspace) error
}

// errDriverUnavailable means the driver cannot run here yet. It counts as a
// failure, so a fixture that lists the driver must tag it xfail.
var errDriverUnavailable = errors.New("driver not available")

func drivers() map[string]Driver {
	return map[string]Driver{"compose": composeDriver{}, "runner": runnerDriver{}}
}

// composeDriver is the compose worker: localworker over HTTP against the
// in-process API, bound through the same startup path compose uses.
type composeDriver struct{}

func (composeDriver) Name() string { return "compose" }

func (composeDriver) Drive(t *testing.T, w *Workspace) error {
	t.Helper()
	ref := authz.PrincipalRef{Issuer: localworker.DefaultIssuer, Subject: fmt.Sprintf("%s-%s", localworker.DefaultSubject, w.Tenant.Slug)}
	res, err := localseed.EnsureWorkerIn(w.env.ctx, localseed.WorkerInput{Store: identity.NewPostgres(w.env.app), Worker: ref}, w.Tenant.Slug, w.WS.WorkbenchKey)
	if err != nil || res.Skipped != "" || res.UserID == "" {
		return fmt.Errorf("bind compose worker: %+v %v", res, err)
	}
	srv := httptest.NewServer(w.env.h)
	defer srv.Close()
	id := "fixturesuite-" + w.Tenant.Slug
	client := localworker.NewHTTP(localworker.HTTPConfig{
		BaseURL: srv.URL, Issuer: ref.Issuer, Subject: ref.Subject, WorkerID: id, Lease: 30 * time.Second,
	})
	_, err = localworker.NewRunner(client, localworker.Config{WorkerID: id}).Drain(w.env.ctx)
	return err
}

// runnerDriver will drive the production runner (internal/runner)
// in-process. TODO(#651 S2): implement once runner Config.Now (optional
// clock, falls back to time.Now; jonny's separate API PR) lands, so
// flow.delay fixtures can advance time. Until then every fixture tags
// runner as xfail and strict xfail keeps that honest.
type runnerDriver struct{}

func (runnerDriver) Name() string { return "runner" }

func (runnerDriver) Drive(*testing.T, *Workspace) error {
	return fmt.Errorf("%w: production runner driver waits for runner Config.Now", errDriverUnavailable)
}
