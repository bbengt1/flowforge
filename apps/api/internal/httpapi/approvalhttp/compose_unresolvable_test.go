package approvalhttp

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestComposeUnresolvableGateDoesNotResumeExpired(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, fmt.Sprintf("cu-%d", suffix%100000000), "CU")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", fmt.Sprintf("cuu-%d", suffix%100000000), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, fmt.Sprintf("cud-%d", suffix%100000000), "Desk", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: compose-unresolvable-` + fmt.Sprintf("%d", suffix%100000000) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1H
    - id: late
      type: flow.stop
      name: Late
      with:
        status: success
  edges:
    - from: gate.expired
      to: late.input
`
	parsed, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := store.Create(ctx, scope, wfstore.CreateInput{
		NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	frozen := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, frozen, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Step.NodeID != "gate" {
		t.Fatalf("claimed %s", claimed.Step.NodeID)
	}
	srv := &core.Server{Workflows: missingVersion{Postgres: store}, Clock: func() time.Time { return frozen }}
	if _, err := ParkApprovalClaim(srv, ctx, scope, claimed); err == nil {
		t.Fatal("unresolvable claim parked")
	}
	assertComposeTerminal(t, ctx, store, scope, exec.ID)
	if _, err := store.RecoverExpiredLeases(ctx, scope, frozen.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	assertComposeTerminal(t, ctx, store, scope, exec.ID)
}

// missingVersion reports the pinned workflow version as gone after the
// run has already been planned, so compose claim cannot rebuild the gate.
type missingVersion struct {
	*wfstore.Postgres
}

func (missingVersion) GetVersion(context.Context, isolation.Scope, string, string) (wfstore.Version, error) {
	return wfstore.Version{}, wfstore.ErrNotFound
}

func assertComposeTerminal(t *testing.T, ctx context.Context, store *wfstore.Postgres, scope isolation.Scope, executionID string) {
	t.Helper()
	exec, err := store.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if exec.Status != wfstore.ExecutionFailed {
		t.Fatalf("run = %s", exec.Status)
	}
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var gate, late wfstore.ExecutionStep
	var gateJob, lateJob wfstore.ExecutionJob
	for _, step := range steps {
		switch step.NodeID {
		case "gate":
			gate = step
		case "late":
			late = step
		}
	}
	for _, job := range jobs {
		switch job.ExecutionStepID {
		case gate.ID:
			gateJob = job
		case late.ID:
			lateJob = job
		}
	}
	if gate.Status != wfstore.ExecutionFailed || gateJob.Status != wfstore.JobFailed {
		t.Fatalf("gate step=%s job=%s", gate.Status, gateJob.Status)
	}
	if code, _ := gate.Error["code"].(string); code != wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("gate error = %+v", gate.Error)
	}
	if port, _ := gate.Output["port"].(string); port == "expired" {
		t.Fatalf("gate took expired: %+v", gate.Output)
	}
	if late.Status == wfstore.ExecutionSucceeded || lateJob.Status == wfstore.JobSucceeded {
		t.Fatalf("late step=%s job=%s", late.Status, lateJob.Status)
	}
	if port, _ := late.Output["port"].(string); port == "expired" || port != "" {
		t.Fatalf("late ran: %+v", late.Output)
	}
}
