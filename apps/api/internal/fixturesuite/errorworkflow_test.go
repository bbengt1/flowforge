package fixturesuite

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5"
)

// ErrorWorkflowExpect opts a part in to a configured workspace error
// workflow (#649 S3). Test-only setup, in the part's fresh workspace:
//   - a published target workflow whose only trigger is `error`, set as the
//     workspace error workflow through the store (the HTTP route needs MFA
//     step-up, which the suite has no way to complete);
//   - an allow policy gate, since the store fails closed (policy_unavailable)
//     with none wired;
//   - the parent started with trigger type api, since manual runs never fire.
//
// Reason, when set, must equal the error run's input reason.
type ErrorWorkflowExpect struct {
	Reason string `yaml:"reason"`
}

const fixtureErrorTargetYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: fixture-on-error
spec:
  triggers:
    - id: on-error
      type: error
  nodes:
    - id: note
      type: data.set
      name: Note
      with:
        value:
          seen: true
`

func fixtureAllowGate(context.Context, pgx.Tx, isolation.Scope, wfstore.Version) string { return "" }

// errorWorkflowStart configures the error workflow and returns a start
// function that starts the parent as an api-triggered run.
func (w *Workspace) errorWorkflowStart(t *testing.T) func(identity.User, string, string, map[string]any) (string, Response) {
	t.Helper()
	owner := w.Users["owner"]
	scope := w.ownerScope(t)
	store := wfstore.NewPostgres(w.env.app)
	d, res := w.Create(owner, fixtureErrorTargetYAML)
	if res.Status != http.StatusCreated {
		t.Fatalf("create error target: %d %s", res.Status, res.Body)
	}
	if _, res := w.Publish(owner, d); res.Status != http.StatusCreated {
		t.Fatalf("publish error target: %d %s", res.Status, res.Body)
	}
	if _, err := store.SetErrorWorkflow(w.env.ctx, scope, d.WorkflowID, wfstore.AuditActor{DisplayName: owner.DisplayName}); err != nil {
		t.Fatalf("set error workflow: %v", err)
	}
	wfstore.SetErrorWorkflowGate(fixtureAllowGate)
	t.Cleanup(func() { wfstore.SetErrorWorkflowGate(nil) })
	return func(_ identity.User, workflowID, versionID string, input map[string]any) (string, Response) {
		exec, err := store.StartExecution(w.env.ctx, scope, workflowID, wfstore.StartInput{
			VersionID:     versionID,
			Input:         input,
			CorrelationID: "fixturesuite",
			TriggerType:   "api",
			RequestedBy:   scope.ActorID(),
		})
		if err != nil {
			body, _ := json.Marshal(map[string]string{"error": err.Error()})
			return "", Response{Status: http.StatusInternalServerError, Body: body}
		}
		// StartExecution writes the execution.start audit itself.
		return exec.ID, Response{Status: http.StatusCreated}
	}
}

// ownerScope is the owner's user scope in this workspace.
func (w *Workspace) ownerScope(t *testing.T) isolation.Scope {
	t.Helper()
	owner := w.Users["owner"]
	var id string
	if err := w.env.admin.QueryRow(w.env.ctx, `SELECT id::text FROM users WHERE issuer = $1 AND external_subject = $2`, owner.Issuer, owner.ExternalSubject).Scan(&id); err != nil {
		t.Fatalf("owner id: %v", err)
	}
	scope, err := isolation.Authorize(w.WS.ID, id)
	if err != nil {
		t.Fatalf("owner scope: %v", err)
	}
	return scope
}

// errorRunReason is the input reason of the workspace's error run for
// parent execID.
func (w *Workspace) errorRunReason(t *testing.T, execID string) string {
	t.Helper()
	var reason string
	if err := w.env.admin.QueryRow(w.env.ctx, `
SELECT COALESCE(input_redacted->>'reason', '') FROM executions
 WHERE workspace_id = $1::uuid AND error_parent_id = $2::uuid`, w.WS.ID, execID).Scan(&reason); err != nil {
		t.Fatalf("error run reason: %v", err)
	}
	return reason
}
