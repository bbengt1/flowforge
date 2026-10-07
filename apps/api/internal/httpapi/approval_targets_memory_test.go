package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// The in-memory stores apply the same park rule as Postgres: a targeted
// gate nobody but the requester could decide fails with
// requirement_unresolvable and cause no_eligible_decider and writes no
// approval; once a second admin exists the same gate parks.
func TestMemoryTargetedGateNoEligibleDecider(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workspace/groups", []byte(`{"displayName":"Memory approvers"}`), admin, tenant, ws))
	if rec.Code != http.StatusCreated {
		t.Fatalf("group: %d %s", rec.Code, rec.Body.String())
	}
	var group identity.Group
	if err := json.Unmarshal(rec.Body.Bytes(), &group); err != nil {
		t.Fatal(err)
	}

	runGate := func(name string) string {
		t.Helper()
		wf := createWorkflow(t, h, admin, tenant, ws, targetedGateYAML(name, nil, []string{group.ID}))
		pub := publishWorkflow(t, h, admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "targets")
		exec := startExecution(t, h, admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/jobs/claim", []byte(`{"workerId":"memory-targets","leaseSeconds":5}`), admin, tenant, ws))
		return exec.ID
	}
	approvalsFor := func(execID string) []approval.Record {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/approvals?executionId="+execID, nil, admin, tenant, ws))
		if rec.Code != http.StatusOK {
			t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
		}
		var listed listResponse[approval.Record]
		if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
			t.Fatal(err)
		}
		return listed.Items
	}

	t.Run("only admin is requester fails", func(t *testing.T) {
		execID := runGate("memory-no-decider")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/executions/"+execID, nil, admin, tenant, ws))
		var got struct {
			Status              string         `json:"status"`
			StatusReason        string         `json:"statusReason"`
			StatusReasonDetails map[string]any `json:"statusReasonDetails"`
			Steps               []struct {
				NodeID string         `json:"nodeId"`
				Status string         `json:"status"`
				Error  map[string]any `json:"error"`
			} `json:"steps"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Status != wfstore.ExecutionFailed || got.StatusReason != wfstore.ReasonRequirementUnresolvable || got.StatusReasonDetails["cause"] != approval.CauseNoEligibleDecider {
			t.Fatalf("execution = %s", rec.Body.String())
		}
		if len(got.Steps) != 1 || got.Steps[0].Error["code"] != wfstore.ReasonRequirementUnresolvable {
			t.Fatalf("steps = %+v", got.Steps)
		}
		if details, _ := got.Steps[0].Error["details"].(map[string]any); details["cause"] != approval.CauseNoEligibleDecider {
			t.Fatalf("step details = %+v", got.Steps[0].Error)
		}
		if items := approvalsFor(execID); len(items) != 0 {
			t.Fatalf("approvals written = %+v", items)
		}
	})

	t.Run("second admin parks", func(t *testing.T) {
		putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"memory-admin-2","role_keys":["admin"]}`)
		execID := runGate("memory-second-admin")
		items := approvalsFor(execID)
		if len(items) != 1 || items[0].Status != approval.StatusPending || items[0].Approvers == nil || len(items[0].Approvers.Groups) != 1 || items[0].Approvers.Groups[0].ID != group.ID {
			t.Fatalf("approvals = %+v", items)
		}
	})
}
