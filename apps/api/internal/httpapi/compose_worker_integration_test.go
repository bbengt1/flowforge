package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// bindComposeWorker binds a compose worker principal in the harness
// workspace through the same startup path the API uses in compose.
func (th *targetsHarness) bindComposeWorker() identity.User {
	th.t.Helper()
	ref := authz.PrincipalRef{Issuer: localworker.DefaultIssuer, Subject: fmt.Sprintf("%s-%d", localworker.DefaultSubject, th.n)}
	in := localseed.WorkerInput{Store: identity.NewPostgres(th.app), Worker: ref}
	res, err := localseed.EnsureWorkerIn(th.ctx, in, th.tenant.Slug, th.ws.WorkbenchKey)
	if err != nil || res.Skipped != "" || res.UserID == "" {
		th.t.Fatalf("bind worker = %+v %v", res, err)
	}
	return identity.User{ID: res.UserID, Issuer: ref.Issuer, ExternalSubject: ref.Subject, DisplayName: localworker.DisplayName}
}

// startAs publishes yaml, starts it as the owner, and returns the execution id.
func (th *targetsHarness) startYAML(yaml string) string {
	th.t.Helper()
	wf := createWorkflow(th.t, th.h, th.owner, th.tenant, th.ws, yaml)
	pub := publishWorkflow(th.t, th.h, th.owner, th.tenant, th.ws, wf.Workflow.ID, wf.Draft.Revision, "compose-worker")
	return startExecution(th.t, th.h, th.owner, th.tenant, th.ws, wf.Workflow.ID, pub.Version.ID).ID
}

// parkAsWorker starts a targeted gate and claims it as the worker. A gate
// with no eligible decider answers the claim with 403 after failing the run.
func (th *targetsHarness) parkAsWorker(worker identity.User, groups []string, wantCode int) string {
	th.t.Helper()
	th.seq++
	execID := th.startYAML(targetedGateYAML(fmt.Sprintf("worker-gate-%d", th.seq), nil, groups))
	rec := th.do(worker, http.MethodPost, "/api/v1/jobs/claim", fmt.Sprintf(`{"workerId":"compose-%d","leaseSeconds":5}`, th.seq))
	if rec.Code != wantCode {
		th.t.Fatalf("worker claim: %d %s", rec.Code, rec.Body.String())
	}
	return execID
}

func (th *targetsHarness) execution(id string) executionResponse {
	th.t.Helper()
	rec := th.do(th.owner, http.MethodGet, "/api/v1/executions/"+id, "")
	if rec.Code != http.StatusOK {
		th.t.Fatalf("get execution: %d %s", rec.Code, rec.Body.String())
	}
	var out executionResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

// TestComposeWorkerClaimsButNeverDecides proves the compose worker binding
// is enough to claim and finish runs and never makes the worker a decider.
func TestComposeWorkerClaimsButNeverDecides(t *testing.T) {
	th := newTargetsHarness(t)
	parent := t
	run := func(name string, fn func(t *testing.T)) {
		parent.Run(name, func(t *testing.T) {
			th.t = t
			defer func() { th.t = parent }()
			fn(t)
		})
	}
	worker := th.bindComposeWorker()
	empty := th.group("Empty approvers")

	run("worker claims and completes a run", func(t *testing.T) {
		execID := th.startYAML(blankDraftYAML)
		srv := httptest.NewServer(th.h)
		defer srv.Close()
		client := localworker.NewHTTP(localworker.HTTPConfig{
			BaseURL: srv.URL, Issuer: worker.Issuer, Subject: worker.ExternalSubject,
			WorkerID: "compose-worker-test", Lease: 30 * time.Second,
		})
		n, err := localworker.NewRunner(client, localworker.Config{WorkerID: "compose-worker-test"}).Drain(th.ctx)
		if err != nil || n < 1 {
			t.Fatalf("drain = %d %v", n, err)
		}
		if got := th.execution(execID); got.Status != wfstore.ExecutionSucceeded {
			t.Fatalf("execution = %s %s", got.Status, got.StatusReason)
		}
	})

	run("sole admin gate still fails no_eligible_decider", func(t *testing.T) {
		got := th.execution(th.parkAsWorker(worker, []string{empty}, http.StatusForbidden))
		if got.Status != wfstore.ExecutionFailed || got.StatusReason != "requirement_unresolvable" || got.StatusReasonDetails["cause"] != approval.CauseNoEligibleDecider {
			t.Fatalf("execution = %s %s %v", got.Status, got.StatusReason, got.StatusReasonDetails)
		}
	})

	run("worker is never an approver candidate", func(t *testing.T) {
		for _, role := range []string{authz.RoleApprover, authz.RoleOperator, authz.RoleAdmin} {
			rec := th.do(th.owner, http.MethodGet, "/api/v1/approvals/approver-candidates?role="+role, "")
			if rec.Code != http.StatusOK {
				t.Fatalf("candidates %s: %d %s", role, rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), worker.ID) {
				t.Fatalf("worker listed for role %s: %s", role, rec.Body.String())
			}
		}
	})

	run("worker is not actionable on a parked gate", func(t *testing.T) {
		admin2 := th.member("cw-admin2", "admin")
		row := th.pendingFor(th.parkAsWorker(worker, []string{empty}, http.StatusOK), admin2)
		if c := row.Capabilities; c == nil || !c.Decide.Allowed {
			t.Fatalf("second admin capabilities = %+v", c)
		}
		if c := th.get(row.ID, worker).Capabilities; c == nil || c.Decide.Allowed || c.Decide.Code != approval.CapMissingPermission {
			t.Fatalf("worker capabilities = %+v", c)
		}
		if th.awaitingMe(worker)[row.ID] {
			t.Fatal("gate awaits the worker")
		}
		if rec := th.decide(row.ID, worker); rec.Code != http.StatusForbidden {
			t.Fatalf("worker decide: %d %s", rec.Code, rec.Body.String())
		}
	})
}
