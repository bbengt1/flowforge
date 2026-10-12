package fixturesuite

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"
)

// auditObs is what a scenario observed: per-action counts and rows.
type auditObs struct {
	counts map[string]int
	rows   map[string][]map[string]any
}

func fromRun(r Run) auditObs { return auditObs{counts: r.Audit, rows: r.AuditRows} }

// workflowAudit reads the workspace audit rows tied to a workflow (the
// workflow itself or details.workflowId).
func (w *secWorld) workflowAudit(t *testing.T, workflowID string) auditObs {
	t.Helper()
	obs := auditObs{counts: map[string]int{}, rows: map[string][]map[string]any{}}
	rows, err := w.env.admin.Query(w.env.ctx, `
SELECT action, outcome, details_redacted FROM audit_events
 WHERE workspace_id = $1::uuid AND (resource_id = $2::uuid OR details_redacted->>'workflowId' = $2::text)`, w.A.WS.ID, workflowID)
	if err != nil {
		t.Fatalf("audit query: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var action, outcome string
		var details map[string]any
		if err := rows.Scan(&action, &outcome, &details); err != nil {
			t.Fatal(err)
		}
		if details == nil {
			details = map[string]any{}
		}
		obs.counts[action]++
		obs.rows[action] = append(obs.rows[action], details)
	}
	return obs
}

func (w *secWorld) runAudit(t *testing.T, c SecCheck, failf func(string, ...any)) {
	t.Helper()
	A, owner := w.A, w.users["owner"]
	var obs auditObs
	approvalDelta := -1
	switch c.Scenario {
	case "linear":
		_, _, exec := w.publishRun(t, A, owner, readFixture(t, "01-linear/workflow.yaml"), true)
		if err := w.d.Drive(t, A); err != nil {
			failf("drive: %v", err)
			return
		}
		obs = fromRun(A.Observe(t, exec))
	case "retry", "skipped":
		_, _, exec := w.publishRun(t, A, owner, readFixture(t, "06-error-output/workflow.yaml"), true)
		if err := w.d.Drive(t, A); err != nil {
			failf("drive: %v", err)
			return
		}
		if c.Scenario == "retry" {
			if res := A.Retry(owner, exec); res.Status != http.StatusCreated {
				failf("retry = %d %s", res.Status, res.Body)
				return
			}
			if err := w.d.Drive(t, A); err != nil {
				failf("drive: %v", err)
				return
			}
		}
		for node, want := range c.SkippedNodeJobAudit {
			if got := w.nodeJobAudit(t, exec, node); got != want {
				failf("job.* audit rows for skipped %s = %d, want %d", node, got, want)
			}
		}
		obs = fromRun(A.Observe(t, exec))
	case "decision", "override":
		src, decider := secGateYAML, w.users["approver"]
		if c.Scenario == "override" {
			// Targeted at the approver; the admin owner (not the
			// requester, not targeted) decides: admin_override.
			src, decider = targetedGate(w.users["approver"].ID), owner
		}
		_, _, exec := w.publishRun(t, A, w.users["requester"], src, true)
		if err := w.d.DriveOnce(t, A); err != nil {
			failf("drive-once: %v", err)
			return
		}
		appr := w.approvalFor(t, A, exec)
		before := w.count(t, "approval_events")
		res := A.Do(decider, http.MethodPost, "/api/v1/approvals/"+appr+"/decide", map[string]any{"decision": "approve", "note": "s3"})
		if res.Status != http.StatusOK {
			failf("decide = %d %s", res.Status, res.Body)
			return
		}
		approvalDelta = w.count(t, "approval_events") - before
		if err := w.d.Drive(t, A); err != nil {
			failf("drive: %v", err)
			return
		}
		// The run's rows plus the approval's own rows, each row once.
		obs = w.runOrResourceAudit(t, exec, appr)
	case "publish":
		draft, _, _ := w.publishRun(t, A, owner, strings.Replace(readFixture(t, "01-linear/workflow.yaml"), "e0-01-linear", "s3-publish-audit", 1), false)
		obs = w.workflowAudit(t, draft.WorkflowID)
	case "delete":
		draft, _, _ := w.publishRun(t, A, owner, strings.Replace(readFixture(t, "01-linear/workflow.yaml"), "e0-01-linear", "s3-delete-audit", 1), false)
		res := A.Do(owner, http.MethodDelete, "/api/v1/workflows/"+draft.WorkflowID, nil)
		if res.Status != http.StatusOK && res.Status != http.StatusNoContent {
			failf("delete = %d %s", res.Status, res.Body)
			return
		}
		obs = w.workflowAudit(t, draft.WorkflowID)
	}
	if c.ApprovalEvents != nil && approvalDelta != *c.ApprovalEvents {
		failf("approval_events rows from the decision = %d, want %d", approvalDelta, *c.ApprovalEvents)
	}
	for _, action := range sortedKeysInt(c.Audit) {
		if got := obs.counts[action]; got != c.Audit[action] {
			failf("audit %s = %d, want %d", action, got, c.Audit[action])
		}
	}
	for _, p := range c.NoActionPrefix {
		for action, n := range obs.counts {
			if strings.HasPrefix(action, p) {
				failf("audit %s = %d, but no %s* action may exist", action, n, p)
			}
		}
	}
	for action, want := range c.AuditDetails {
		rows := obs.rows[action]
		if len(rows) == 0 {
			failf("auditDetails %s: no rows", action)
		}
		for i, got := range rows {
			if !subset(norm(want), norm(got)) {
				failf("auditDetails %s[%d] = %v, want ⊇ %v", action, i, got, want)
			}
		}
	}
	for action, keys := range c.DetailsKeys {
		rows := obs.rows[action]
		if len(rows) == 0 {
			failf("detailsKeys %s: no rows", action)
		}
		want := append([]string(nil), keys...)
		sort.Strings(want)
		scope := map[string]string{"tenantId": w.A.Tenant.ID, "workspaceId": w.A.WS.ID}
		allowedScope := boolSet(c.DetailsScopeKeys[action])
		for i, got := range rows {
			var have []string
			for k, v := range got {
				if allowedScope[k] {
					// Accepted only as the row's own tenant/workspace.
					if own, ok := scope[k]; !ok || fmt.Sprint(v) != own {
						failf("detailsKeys %s[%d] %s = %v, want the run's own %s %q", action, i, k, v, k, own)
					}
					continue
				}
				have = append(have, k)
			}
			sort.Strings(have)
			if fmt.Sprint(have) != fmt.Sprint(want) {
				failf("detailsKeys %s[%d] = %v, want exactly %v", action, i, have, want)
			}
		}
	}
	for action, keys := range c.DetailsMustNotContain {
		for i, got := range obs.rows[action] {
			for _, k := range keys {
				if _, ok := got[k]; ok {
					failf("audit %s[%d] details contain %q", action, i, k)
				}
			}
		}
	}
}

// runOrResourceAudit reads each audit row tied to the run (as Observe
// does) or to resource id exactly once.
func (w *secWorld) runOrResourceAudit(t *testing.T, execID, id string) auditObs {
	t.Helper()
	obs := auditObs{counts: map[string]int{}, rows: map[string][]map[string]any{}}
	rows, err := w.env.admin.Query(w.env.ctx, `
SELECT action, details_redacted FROM audit_events
 WHERE workspace_id = $1::uuid
   AND (resource_id = $2::uuid OR resource_id = $3::uuid
        OR resource_id IN (SELECT id FROM execution_steps WHERE execution_id = $2::uuid)
        OR resource_id IN (SELECT id FROM execution_jobs WHERE execution_id = $2::uuid)
        OR details_redacted->>'executionId' = $2::text)`, w.A.WS.ID, execID, id)
	if err != nil {
		t.Fatalf("audit query: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var a string
		var d map[string]any
		if err := rows.Scan(&a, &d); err != nil {
			t.Fatal(err)
		}
		obs.counts[a]++
		obs.rows[a] = append(obs.rows[a], d)
	}
	return obs
}

// nodeJobAudit counts job.* audit rows tied to a node's step or jobs.
func (w *secWorld) nodeJobAudit(t *testing.T, execID, node string) int {
	t.Helper()
	var n int
	err := w.env.admin.QueryRow(w.env.ctx, `
SELECT count(*) FROM audit_events a
 WHERE a.workspace_id = $1::uuid AND a.action LIKE 'job.%'
   AND (a.resource_id IN (SELECT id FROM execution_steps WHERE execution_id = $2::uuid AND node_id = $3)
        OR a.resource_id IN (SELECT j.id FROM execution_jobs j JOIN execution_steps s ON s.id = j.execution_step_id
                              WHERE j.execution_id = $2::uuid AND s.node_id = $3)
        OR (a.details_redacted->>'executionId' = $2::text AND a.details_redacted->>'nodeId' = $3))`, w.A.WS.ID, execID, node).Scan(&n)
	if err != nil {
		t.Fatalf("node job audit: %v", err)
	}
	return n
}
