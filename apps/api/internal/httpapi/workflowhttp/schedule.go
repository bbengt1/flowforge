package workflowhttp

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type createScheduleRequest struct {
	ID                string `json:"id"`
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceIDAlt    string `json:"workspaceId"`
	WorkflowID        string `json:"workflowId"`
	WorkflowVersionID string `json:"workflowVersionId"`
	TriggerID         string `json:"triggerId"`
	Timezone          string `json:"timezone"`
	Cron              string `json:"cron"`
	Interval          string `json:"interval"`
	OverlapPolicy     string `json:"overlapPolicy"`
	MisfirePolicy     string `json:"misfirePolicy"`
	CatchUp           *int   `json:"catchUp"`
}

type updateScheduleRequest struct {
	ID                string  `json:"id"`
	WorkspaceID       string  `json:"workspace_id"`
	WorkspaceIDAlt    string  `json:"workspaceId"`
	WorkflowVersionID *string `json:"workflowVersionId"`
	TriggerID         *string `json:"triggerId"`
	Timezone          *string `json:"timezone"`
	Cron              *string `json:"cron"`
	Interval          *string `json:"interval"`
	OverlapPolicy     *string `json:"overlapPolicy"`
	MisfirePolicy     *string `json:"misfirePolicy"`
	CatchUp           *int    `json:"catchUp"`
}

type dispatchSchedulesRequest struct {
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceIDAlt string `json:"workspaceId"`
	ScheduleID     string `json:"scheduleId"`
}

type scheduleDispatchItem struct {
	ScheduleID  string             `json:"scheduleId"`
	ExecutionID string             `json:"executionId,omitempty"`
	SkipReason  string             `json:"skipReason,omitempty"`
	FireAt      *time.Time         `json:"fireAt,omitempty"`
	Error       string             `json:"error,omitempty"`
	Execution   *wfstore.Execution `json:"execution,omitempty"`
}

type ScheduleDispatchResponse struct {
	Items []scheduleDispatchItem `json:"items"`
}

func requireSchedules(s *core.Server, w http.ResponseWriter, r *http.Request) bool {
	if s.Schedules != nil {
		return true
	}
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Schedules are not available.")
	return false
}

func reservedScheduleCollection(id string) bool {
	switch strings.TrimSpace(id) {
	case "catalog", "dispatch":
		return true
	default:
		return false
	}
}

func getScheduleCatalog(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if _, ok := WorkflowScope(s, w, r, authz.PermWorkflowView); !ok {
		return
	}
	core.WriteJSON(w, http.StatusOK, schedule.TypeCatalog())
}

func listSchedules(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok || !requireSchedules(s, w, r) {
		return
	}
	q, ok := core.ParsePage(w, r)
	if !ok {
		return
	}
	workflowID := strings.TrimSpace(r.URL.Query().Get("workflowId"))
	if workflowID != "" {
		if s.Workflows == nil {
			core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Workflow store is not available.")
			return
		}
		if _, err := s.Workflows.Get(r.Context(), scope, workflowID); err != nil {
			WriteWorkflowStoreError(w, r, err)
			return
		}
	}
	items, next, err := s.Schedules.ListPage(r.Context(), scope, workflowID, q)
	if core.RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	items, err = omitTombstonedSchedules(r.Context(), s, scope, items)
	if err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WritePage(w, items, q, next)
}

func createSchedule(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireSchedules(s, w, r) {
		return
	}
	var req createScheduleRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	workflowID := strings.TrimSpace(req.WorkflowID)
	if _, err := s.Workflows.Get(r.Context(), scope, workflowID); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	ver, err := s.Workflows.GetVersion(r.Context(), scope, workflowID, strings.TrimSpace(req.WorkflowVersionID))
	if err != nil {
		if errors.Is(err, wfstore.ErrNotFound) || errors.Is(err, wfstore.ErrDraftNotRunnable) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Schedules must pin a published workflow version.")
			return
		}
		WriteWorkflowStoreError(w, r, err)
		return
	}
	in := schedule.CreateInput{
		WorkflowID:        workflowID,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		TriggerID:         strings.TrimSpace(req.TriggerID),
		Timezone:          strings.TrimSpace(req.Timezone),
		Cron:              strings.TrimSpace(req.Cron),
		Interval:          strings.TrimSpace(req.Interval),
		OverlapPolicy:     strings.TrimSpace(req.OverlapPolicy),
		MisfirePolicy:     strings.TrimSpace(req.MisfirePolicy),
		CatchUp:           req.CatchUp,
	}
	applyScheduleYAMLDefaults(&in, ver.DefinitionYAML)
	rec, err := s.Schedules.Create(r.Context(), scope, s.Clock().UTC(), in)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	writeScheduleAudit(s, r.Context(), scope, rec, "created", nil)
	core.WriteJSON(w, http.StatusCreated, rec)
}

func getSchedule(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if reservedScheduleCollection(r.PathValue("scheduleId")) {
		core.WriteProblem(w, r, http.StatusMethodNotAllowed, core.CodeMethodNotAllowed, "Method Not Allowed", "The "+r.Method+" method is not allowed for this path.")
		return
	}
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowView)
	if !ok || !requireSchedules(s, w, r) {
		return
	}
	rec, err := s.Schedules.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("scheduleId")))
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	if err := LiveWorkflow(r.Context(), s.Workflows, scope, rec.WorkflowID); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, rec)
}

func updateSchedule(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireSchedules(s, w, r) {
		return
	}
	var req updateScheduleRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	current, err := s.Schedules.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("scheduleId")))
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	if err := LiveWorkflow(r.Context(), s.Workflows, scope, current.WorkflowID); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	in := schedule.UpdateInput{
		TriggerID:     req.TriggerID,
		Timezone:      req.Timezone,
		Cron:          req.Cron,
		Interval:      req.Interval,
		OverlapPolicy: req.OverlapPolicy,
		MisfirePolicy: req.MisfirePolicy,
		CatchUp:       req.CatchUp,
	}
	if req.WorkflowVersionID != nil {
		ver, err := s.Workflows.GetVersion(r.Context(), scope, current.WorkflowID, strings.TrimSpace(*req.WorkflowVersionID))
		if err != nil {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Schedules must pin a published workflow version.")
			return
		}
		id := ver.ID
		digest := ver.Digest
		in.WorkflowVersionID = &id
		in.WorkflowDigest = &digest
	}
	rec, err := s.Schedules.Update(r.Context(), scope, s.Clock().UTC(), current.ID, in)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	writeScheduleAudit(s, r.Context(), scope, rec, "updated", nil)
	core.WriteJSON(w, http.StatusOK, rec)
}

func enableSchedule(s *core.Server, w http.ResponseWriter, r *http.Request) {
	setScheduleStatus(s, w, r, schedule.StatusEnabled)
}

func disableSchedule(s *core.Server, w http.ResponseWriter, r *http.Request) {
	setScheduleStatus(s, w, r, schedule.StatusDisabled)
}

func setScheduleStatus(s *core.Server, w http.ResponseWriter, r *http.Request, status string) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireSchedules(s, w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("scheduleId"))
	current, err := s.Schedules.Get(r.Context(), scope, id)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	if err := LiveWorkflow(r.Context(), s.Workflows, scope, current.WorkflowID); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	rec, err := s.Schedules.SetStatus(r.Context(), scope, s.Clock().UTC(), id, status)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	writeScheduleAudit(s, r.Context(), scope, rec, status, nil)
	core.WriteJSON(w, http.StatusOK, rec)
}

func deleteSchedule(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowEdit)
	if !ok || !requireSchedules(s, w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("scheduleId"))
	rec, _ := s.Schedules.Get(r.Context(), scope, id)
	if err := s.Schedules.Delete(r.Context(), scope, id); err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	if rec.ID != "" {
		writeScheduleAudit(s, r.Context(), scope, rec, "deleted", nil)
	}
	w.WriteHeader(http.StatusNoContent)
}

func dispatchSchedules(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, ok := WorkflowScope(s, w, r, authz.PermWorkflowExecute)
	if !ok || !requireSchedules(s, w, r) {
		return
	}
	var req dispatchSchedulesRequest
	if r.ContentLength > 0 || r.Header.Get("Content-Type") != "" {
		if !core.DecodeJSON(w, r, &req) {
			return
		}
		if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	items, err := dispatchDue(s, r.Context(), scope, Now(s), strings.TrimSpace(req.ScheduleID))
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	if items == nil {
		items = []scheduleDispatchItem{}
	}
	core.WriteJSON(w, http.StatusOK, ScheduleDispatchResponse{Items: items})
}

// dispatchDue starts published, enabled schedules that are due in scope.
// A missing version is skipped (drafts and unpublished pins never run).
func dispatchDue(s *core.Server, ctx context.Context, scope isolation.Scope, now time.Time, scheduleID string) ([]scheduleDispatchItem, error) {
	if s.Schedules == nil {
		return nil, schedule.ErrStoreUnavailable
	}
	if s.Workflows == nil {
		return nil, wfstore.ErrStoreUnavailable
	}
	due, err := s.Schedules.ListDue(ctx, scope, now)
	if err != nil {
		return nil, err
	}
	out := make([]scheduleDispatchItem, 0, len(due))
	for _, rec := range due {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		if scheduleID != "" && rec.ID != scheduleID {
			continue
		}
		out = append(out, dispatchOneSchedule(s, ctx, scope, rec, now)...)
		if err := ctx.Err(); err != nil {
			return out, err
		}
	}
	return out, nil
}

func dispatchOneSchedule(s *core.Server, ctx context.Context, scope isolation.Scope, rec schedule.Record, now time.Time) []scheduleDispatchItem {
	if ctx.Err() != nil {
		return nil
	}
	// A tombstoned parent is not a transient miss. Disable the row and
	// leave last_error alone so the next tick does not retry it.
	if err := LiveWorkflow(ctx, s.Workflows, scope, rec.WorkflowID); errors.Is(err, wfstore.ErrNotFound) {
		if _, stopErr := s.Schedules.SetStatus(ctx, scope, now, rec.ID, schedule.StatusDisabled); stopErr != nil {
			return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "workflow-deleted", Error: "workflow-deleted"}}
		}
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "workflow-deleted"}}
	} else if err != nil {
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "workflow-unavailable", Error: "workflow-unavailable"}}
	}
	if rec.Status != schedule.StatusEnabled {
		next, _ := advanceSchedule(s, ctx, scope, rec, now, "disabled", "")
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "disabled", FireAt: timePtr(next)}}
	}
	ver, err := s.Workflows.GetVersion(ctx, scope, rec.WorkflowID, rec.WorkflowVersionID)
	if err != nil {
		next, _ := advanceSchedule(s, ctx, scope, rec, now, "unpublished", err.Error())
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "unpublished", Error: "unpublished", FireAt: timePtr(next)}}
	}
	active := scheduleHasActive(s, ctx, scope, rec)
	plan, err := schedule.PlanFires(rec, now, active)
	if err != nil {
		next, _ := advanceSchedule(s, ctx, scope, rec, now, "invalid", err.Error())
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "invalid", Error: err.Error(), FireAt: timePtr(next)}}
	}
	if plan.SkipReason != "" || len(plan.Fires) == 0 {
		_, _ = s.Schedules.RecordFire(ctx, scope, now, rec.ID, schedule.FireUpdate{NextFireAt: plan.NextFireAt})
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: core.FirstNonEmpty(plan.SkipReason, "not-due"), FireAt: timePtr(plan.NextFireAt)}}
	}
	var items []scheduleDispatchItem
	lastID := rec.LastExecutionID
	lastErr := ""
	var lastFired *time.Time
	for _, fireAt := range plan.Fires {
		// Stop before the next start. Skip RecordFire so the row stays
		// due; the next leader replays any fire that already started
		// (one idempotency key per slot) and does not double-dispatch.
		if ctx.Err() != nil {
			return items
		}
		item, execID, fireErr := startScheduleFire(s, ctx, scope, rec, ver, fireAt)
		items = append(items, item)
		if execID != "" {
			lastID = execID
			t := fireAt.UTC()
			lastFired = &t
		}
		if fireErr != "" {
			lastErr = fireErr
		}
	}
	_, _ = s.Schedules.RecordFire(ctx, scope, now, rec.ID, schedule.FireUpdate{
		NextFireAt:      plan.NextFireAt,
		LastFiredAt:     lastFired,
		LastExecutionID: lastID,
		LastError:       lastErr,
	})
	return items
}

func startScheduleFire(s *core.Server, ctx context.Context, scope isolation.Scope, rec schedule.Record, ver wfstore.Version, fireAt time.Time) (scheduleDispatchItem, string, string) {
	item := scheduleDispatchItem{ScheduleID: rec.ID, FireAt: timePtr(fireAt.UTC())}
	if strings.TrimSpace(ver.ID) == "" {
		item.SkipReason = "unpublished"
		item.Error = "unpublished"
		return item, "", item.SkipReason
	}
	idem := schedule.IdempotencyKey(rec.ID, fireAt)
	start := wfstore.StartInput{
		VersionID:      ver.ID,
		IdempotencyKey: idem,
		Input:          map[string]any{},
		CorrelationID:  core.RequestIDFromContext(ctx),
		TriggerID:      rec.ID,
		TriggerType:    schedule.TypeSchedule,
		RequestedBy:    core.FirstNonEmpty(rec.CreatedBy, scope.ActorID()),
		PolicySnapshot: map[string]any{"triggerType": schedule.TypeSchedule, "scheduleId": rec.ID, "scheduleCreatedBy": rec.CreatedBy},
		HostContext:    map[string]any{"requestId": core.RequestIDFromContext(ctx), "scheduleId": rec.ID},
	}
	exec, replayed, err := dispatchScheduleExecution(s, ctx, scope, rec, ver, start)
	if err != nil {
		item.Error = err.Error()
		item.SkipReason = "start-failed"
		writeScheduleAudit(s, ctx, scope, rec, "denied", map[string]any{"reason": item.SkipReason, "fireAt": fireAt.UTC()})
		return item, "", item.SkipReason
	}
	item.ExecutionID = exec.ID
	cp := exec
	item.Execution = &cp
	if replayed {
		item.SkipReason = "replayed"
	}
	return item, exec.ID, ""
}

func dispatchScheduleExecution(s *core.Server, ctx context.Context, scope isolation.Scope, rec schedule.Record, ver wfstore.Version, start wfstore.StartInput) (wfstore.Execution, bool, error) {
	if strings.TrimSpace(start.VersionID) == "" {
		return wfstore.Execution{}, false, wfstore.ErrDraftNotRunnable
	}
	workflowID := rec.WorkflowID
	if start.IdempotencyKey != "" {
		existing, peekErr := s.Workflows.PeekIdempotent(ctx, scope, workflowID, start)
		if peekErr == nil {
			writeScheduleAudit(s, ctx, scope, rec, "replayed", map[string]any{"executionId": existing.ID})
			return existing, true, nil
		}
		if !errors.Is(peekErr, wfstore.ErrNotFound) {
			return wfstore.Execution{}, false, peekErr
		}
	}
	if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 && s.Ops != nil {
		if _, err := s.Ops.Resolve(ctx, scope, refs); err != nil {
			return wfstore.Execution{}, false, err
		}
	}
	if s.Approvals != nil {
		eval, evalErr := approvalhttp.EvaluateVersion(s, ctx, scope, workflowID, ver.ID)
		if evalErr != nil {
			return wfstore.Execution{}, false, evalErr
		}
		if eval.Decision == policy.DecisionDeny {
			s.EmitAlertCtx(ctx, scope, opsalert.Signal{
				Kind:         opsalert.KindPolicy,
				Action:       "schedule.dispatch",
				ResourceType: "workflow_schedule",
				ResourceID:   rec.ID,
				Code:         core.CodeForbidden,
				Details:      map[string]any{"reason": "policy-deny"},
			})
			return wfstore.Execution{}, false, approvalhttp.ErrPolicyDenied
		}
		if _, gateErr := approvalhttp.DispatchApprovalsOK(s, ctx, scope, eval, workflowID, ver.ID); gateErr != nil {
			return wfstore.Execution{}, false, gateErr
		}
	}
	exec, err := s.Workflows.StartExecution(ctx, scope, workflowID, s.CapStart(start))
	if err != nil {
		return wfstore.Execution{}, false, err
	}
	if exec.Replayed {
		writeScheduleAudit(s, ctx, scope, rec, "replayed", map[string]any{"executionId": exec.ID})
		return exec, true, nil
	}
	if s.Ops != nil {
		copied, copyErr := s.Ops.CopyPins(ctx, scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID)
		if copyErr != nil {
			return wfstore.Execution{}, false, copyErr
		}
		if len(copied) == 0 {
			if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 {
				if _, err := s.Ops.CopyPins(ctx, scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID); err != nil {
					return wfstore.Execution{}, false, err
				}
			}
		}
	}
	writeScheduleAudit(s, ctx, scope, rec, "created", map[string]any{"executionId": exec.ID})
	return exec, false, nil
}

func scheduleHasActive(s *core.Server, ctx context.Context, scope isolation.Scope, rec schedule.Record) bool {
	items, err := s.Workflows.ListExecutions(ctx, scope, wfstore.ExecutionListFilter{WorkflowID: rec.WorkflowID, Limit: 100})
	if err != nil {
		return false
	}
	for _, exec := range items {
		if exec.TriggerID != rec.ID {
			continue
		}
		if wfstoreActive(exec.Status) {
			return true
		}
	}
	return false
}

func wfstoreActive(status string) bool {
	switch status {
	case wfstore.ExecutionQueued, wfstore.ExecutionRunning, wfstore.ExecutionWaiting:
		return true
	default:
		return false
	}
}

func advanceSchedule(s *core.Server, ctx context.Context, scope isolation.Scope, rec schedule.Record, now time.Time, reason, lastErr string) (time.Time, error) {
	next, err := schedule.NextAfter(rec, now)
	if err != nil {
		return time.Time{}, err
	}
	_, err = s.Schedules.RecordFire(ctx, scope, now, rec.ID, schedule.FireUpdate{NextFireAt: next, LastError: lastErr})
	writeScheduleAudit(s, ctx, scope, rec, "denied", map[string]any{"reason": reason})
	return next, err
}

// LiveWorkflow reports whether workflowID is a live row. A tombstone is
// wfstore.ErrNotFound, the same result as GET /workflows/{id} and the
// ?workflowId= schedule filter.
func LiveWorkflow(ctx context.Context, workflows wfstore.Store, scope isolation.Scope, workflowID string) error {
	if workflows == nil {
		return wfstore.ErrStoreUnavailable
	}
	_, err := workflows.Get(ctx, scope, strings.TrimSpace(workflowID))
	return err
}

func omitTombstonedSchedules(ctx context.Context, s *core.Server, scope isolation.Scope, items []schedule.Record) ([]schedule.Record, error) {
	live := map[string]bool{}
	out := make([]schedule.Record, 0, len(items))
	for _, item := range items {
		ok, seen := live[item.WorkflowID]
		if !seen {
			err := LiveWorkflow(ctx, s.Workflows, scope, item.WorkflowID)
			if errors.Is(err, wfstore.ErrNotFound) {
				live[item.WorkflowID] = false
				continue
			}
			if err != nil {
				return nil, err
			}
			live[item.WorkflowID] = true
			ok = true
		}
		if !ok {
			continue
		}
		out = append(out, item)
	}
	return out, nil
}

func applyScheduleYAMLDefaults(in *schedule.CreateInput, yamlDoc string) {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return
	}
	var trig *workflow.Trigger
	for i := range res.Document.Spec.Triggers {
		t := &res.Document.Spec.Triggers[i]
		if t.Type != schedule.TypeSchedule {
			continue
		}
		if in.TriggerID != "" && t.ID != in.TriggerID {
			continue
		}
		trig = t
		break
	}
	if trig == nil {
		return
	}
	if in.TriggerID == "" {
		in.TriggerID = trig.ID
	}
	if in.Timezone == "" {
		in.Timezone, _ = trig.With["timezone"].(string)
	}
	if in.Cron == "" && in.Interval == "" {
		in.Cron, _ = trig.With["cron"].(string)
		in.Interval, _ = trig.With["interval"].(string)
	}
	if in.OverlapPolicy == "" {
		in.OverlapPolicy, _ = trig.With["overlapPolicy"].(string)
	}
	if in.MisfirePolicy == "" {
		in.MisfirePolicy, _ = trig.With["misfirePolicy"].(string)
	}
	if in.CatchUp == nil {
		switch n := trig.With["catchUp"].(type) {
		case int:
			in.CatchUp = &n
		case int64:
			v := int(n)
			in.CatchUp = &v
		case float64:
			v := int(n)
			in.CatchUp = &v
		}
	}
}

func writeScheduleAudit(s *core.Server, ctx context.Context, scope isolation.Scope, rec schedule.Record, outcome string, extra map[string]any) {
	if s.Workflows == nil {
		return
	}
	details := map[string]any{
		"scheduleId":        rec.ID,
		"workflowId":        rec.WorkflowID,
		"workflowVersionId": rec.WorkflowVersionID,
		"triggerType":       schedule.TypeSchedule,
		"correlationId":     core.RequestIDFromContext(ctx),
		"outcome":           outcome,
	}
	for k, v := range extra {
		details[k] = v
	}
	resourceType := "workflow_schedule"
	resourceID := rec.ID
	if execID, ok := extra["executionId"].(string); ok && execID != "" {
		resourceType = "execution"
		resourceID = execID
	}
	_, _ = s.Workflows.WriteAudit(ctx, scope, wfstore.AuditWrite{
		Action:        "execution.start",
		ResourceType:  resourceType,
		ResourceID:    resourceID,
		Outcome:       outcome,
		CorrelationID: core.RequestIDFromContext(ctx),
		HostContext:   map[string]any{"requestId": core.RequestIDFromContext(ctx)},
		Details:       details,
	})
}

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	u := t.UTC()
	return &u
}

func writeScheduleStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, schedule.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, schedule.ErrUnpublished):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Schedules must pin a published workflow version.")
	case errors.Is(err, schedule.ErrTimezone):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Schedule timezone must be a valid IANA name.")
	case errors.Is(err, schedule.ErrDisabled):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Schedule is disabled.")
	case errors.Is(err, schedule.ErrOverlap):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Schedule overlap was rejected.")
	case errors.Is(err, schedule.ErrInvalid), errors.Is(err, schedule.ErrNoScope):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Schedule configuration is invalid.")
	case errors.Is(err, schedule.ErrConflict):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "A schedule with this identity already exists.")
	case errors.Is(err, schedule.ErrStoreUnavailable):
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Dependency Unavailable", "Schedule store is not available.")
	case errors.Is(err, approvalhttp.ErrPolicyDenied):
		core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", "Policy denied this dispatch.")
	case errors.Is(err, approvalhttp.ErrApprovalRequired):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeConflict, "Conflict", "Dispatch requires a valid approval bound to the current workflow version, target, policy revision, and operation.")
	default:
		core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
