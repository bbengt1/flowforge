package runner

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestScopeForDoesNotInferSystem(t *testing.T) {
	if triggerSchedule != schedule.TypeSchedule || triggerWebhook != webhook.TypeWebhook {
		t.Fatal("trigger constants drifted from schedule/webhook")
	}
	ws := Workspace{ID: wsID}
	if _, err := scopeFor(ws); !errors.Is(err, isolation.ErrNoActor) {
		t.Fatalf("empty worker scopeFor = %v", err)
	}
	for _, trig := range []string{triggerSchedule, triggerWebhook, triggerResync} {
		scope, err := scopeForJob(ws, wfstore.Execution{PolicySnapshot: map[string]any{"triggerType": trig}})
		if err != nil {
			t.Fatalf("%s: %v", trig, err)
		}
		if !scope.System() || scope.ActorID() != "" || scope.WorkspaceID() != wsID {
			t.Fatalf("%s scope system=%v actor=%q", trig, scope.System(), scope.ActorID())
		}
	}
	for _, trig := range []string{"manual", "api", ""} {
		exec := wfstore.Execution{ID: "33333333-3333-4333-8333-333333333333"}
		if trig != "" {
			exec.PolicySnapshot = map[string]any{"triggerType": trig}
		}
		if _, err := scopeForJob(ws, exec); !errors.Is(err, isolation.ErrNoActor) {
			t.Fatalf("%q scopeForJob = %v", trig, err)
		}
		failure, refuse := missingActorFailure(exec)
		if !refuse || failure["code"] != wfstore.ReasonMissingActor {
			t.Fatalf("%q failure = %#v refuse=%v", trig, failure, refuse)
		}
		if msg, _ := failure["message"].(string); strings.Contains(msg, "actor") {
			t.Fatalf("detail names an actor: %q", msg)
		}
	}
	okExec := wfstore.Execution{RequestedBy: actorID, PolicySnapshot: map[string]any{"triggerType": "manual"}}
	if _, refuse := missingActorFailure(okExec); refuse {
		t.Fatal("a requester must not be refused")
	}
	for _, trig := range []string{triggerSchedule, triggerWebhook, triggerResync} {
		exec := wfstore.Execution{PolicySnapshot: map[string]any{"triggerType": trig}}
		if _, refuse := missingActorFailure(exec); refuse {
			t.Fatalf("%s run was refused", trig)
		}
	}
	person := Workspace{ID: wsID, ActorID: actorID, TenantID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", WorkbenchKey: "ops"}
	scope, err := scopeForJob(person, wfstore.Execution{PolicySnapshot: map[string]any{"triggerType": "manual"}})
	if err != nil {
		t.Fatal(err)
	}
	if scope.System() || scope.ActorID() != actorID {
		t.Fatalf("worker scope system=%v actor=%q", scope.System(), scope.ActorID())
	}
}

func TestRunnerFailsManualAndAPIWithoutRequester(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	ver := r.publish(t, coreYAML("stop", "flow.stop", "status: success"))
	sys, err := isolation.AuthorizeSystem(wsID)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, trig := range []string{schedule.TypeSchedule, webhook.TypeWebhook, "resync"} {
		exec, err := r.wf.StartExecution(ctx, sys, ver.WorkflowID, wfstore.StartInput{
			VersionID:   ver.ID,
			TriggerType: trig,
		})
		if err != nil {
			t.Fatalf("%s start: %v", trig, err)
		}
		if exec.RequestedBy != "" {
			t.Fatalf("%s requestedBy = %q", trig, exec.RequestedBy)
		}
	}
	for _, trig := range []string{"manual", "api"} {
		if _, err := r.wf.StartExecution(ctx, sys, ver.WorkflowID, wfstore.StartInput{
			VersionID:   ver.ID,
			TriggerType: trig,
		}); !errors.Is(err, wfstore.ErrInvalid) {
			t.Fatalf("%s start = %v, want ErrInvalid", trig, err)
		}
		// Older rows can still exist. Plant one directly so the runner
		// backstop is what fails the job, not StartExecution.
		if _, err := r.wf.PlantExecutionForTest(ctx, sys, ver.WorkflowID, wfstore.StartInput{
			VersionID:   ver.ID,
			TriggerType: trig,
		}); err != nil {
			t.Fatalf("%s plant: %v", trig, err)
		}
	}
	if _, err := r.loop.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	execs, err := r.wf.ListExecutions(ctx, r.scope, wfstore.ExecutionListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	var ran, failed int
	for _, exec := range execs {
		steps, err := r.wf.ListSteps(ctx, r.scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		trig, _ := exec.PolicySnapshot["triggerType"].(string)
		switch trig {
		case schedule.TypeSchedule, webhook.TypeWebhook, "resync":
			if exec.Status != wfstore.ExecutionSucceeded {
				t.Fatalf("%s status = %s", trig, exec.Status)
			}
			ran++
		case "manual", "api":
			if exec.Status != wfstore.ExecutionFailed {
				t.Fatalf("%s status = %s, want failed", trig, exec.Status)
			}
			saw := false
			for _, step := range steps {
				if step.Error["code"] == wfstore.ReasonMissingActor {
					saw = true
					if msg, _ := step.Error["message"].(string); msg != wfstore.MissingActorDetail || strings.Contains(msg, "actor") {
						t.Fatalf("detail = %q", msg)
					}
				}
			}
			if !saw {
				t.Fatalf("%s steps missing %s: %+v", trig, wfstore.ReasonMissingActor, steps)
			}
			failed++
		default:
			t.Fatalf("unexpected trigger %q", trig)
		}
	}
	if ran != 3 || failed != 2 {
		t.Fatalf("ran=%d failed=%d execs=%d", ran, failed, len(execs))
	}
}
