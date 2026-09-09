package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
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

type scheduleDispatchResponse struct {
	Items []scheduleDispatchItem `json:"items"`
}

func (s *Server) requireSchedules(w http.ResponseWriter, r *http.Request) bool {
	if s.schedules != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Schedules are not available.")
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

func (s *Server) getScheduleCatalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.workflowScope(w, r, authz.PermWorkflowView); !ok {
		return
	}
	writeJSON(w, http.StatusOK, schedule.TypeCatalog())
}

func (s *Server) listSchedules(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok || !s.requireSchedules(w, r) {
		return
	}
	items, err := s.schedules.List(r.Context(), scope, strings.TrimSpace(r.URL.Query().Get("workflowId")))
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[schedule.Record]{Items: items})
}

func (s *Server) createSchedule(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireSchedules(w, r) {
		return
	}
	var req createScheduleRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	workflowID := strings.TrimSpace(req.WorkflowID)
	if _, err := s.workflows.Get(r.Context(), scope, workflowID); err != nil {
		writeWorkflowStoreError(w, r, err)
		return
	}
	ver, err := s.workflows.GetVersion(r.Context(), scope, workflowID, strings.TrimSpace(req.WorkflowVersionID))
	if err != nil {
		if errors.Is(err, wfstore.ErrNotFound) || errors.Is(err, wfstore.ErrDraftNotRunnable) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Schedules must pin a published workflow version.")
			return
		}
		writeWorkflowStoreError(w, r, err)
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
	rec, err := s.schedules.Create(r.Context(), scope, s.clock().UTC(), in)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	s.writeScheduleAudit(r, scope, rec, "created", nil)
	writeJSON(w, http.StatusCreated, rec)
}

func (s *Server) getSchedule(w http.ResponseWriter, r *http.Request) {
	if reservedScheduleCollection(r.PathValue("scheduleId")) {
		WriteProblem(w, r, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed", "The "+r.Method+" method is not allowed for this path.")
		return
	}
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowView)
	if !ok || !s.requireSchedules(w, r) {
		return
	}
	rec, err := s.schedules.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("scheduleId")))
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) updateSchedule(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireSchedules(w, r) {
		return
	}
	var req updateScheduleRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	current, err := s.schedules.Get(r.Context(), scope, strings.TrimSpace(r.PathValue("scheduleId")))
	if err != nil {
		writeScheduleStoreError(w, r, err)
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
		ver, err := s.workflows.GetVersion(r.Context(), scope, current.WorkflowID, strings.TrimSpace(*req.WorkflowVersionID))
		if err != nil {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Schedules must pin a published workflow version.")
			return
		}
		id := ver.ID
		digest := ver.Digest
		in.WorkflowVersionID = &id
		in.WorkflowDigest = &digest
	}
	rec, err := s.schedules.Update(r.Context(), scope, s.clock().UTC(), current.ID, in)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	s.writeScheduleAudit(r, scope, rec, "updated", nil)
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) enableSchedule(w http.ResponseWriter, r *http.Request) {
	s.setScheduleStatus(w, r, schedule.StatusEnabled)
}

func (s *Server) disableSchedule(w http.ResponseWriter, r *http.Request) {
	s.setScheduleStatus(w, r, schedule.StatusDisabled)
}

func (s *Server) setScheduleStatus(w http.ResponseWriter, r *http.Request, status string) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireSchedules(w, r) {
		return
	}
	rec, err := s.schedules.SetStatus(r.Context(), scope, s.clock().UTC(), strings.TrimSpace(r.PathValue("scheduleId")), status)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	s.writeScheduleAudit(r, scope, rec, status, nil)
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) deleteSchedule(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowEdit)
	if !ok || !s.requireSchedules(w, r) {
		return
	}
	id := strings.TrimSpace(r.PathValue("scheduleId"))
	rec, _ := s.schedules.Get(r.Context(), scope, id)
	if err := s.schedules.Delete(r.Context(), scope, id); err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	if rec.ID != "" {
		s.writeScheduleAudit(r, scope, rec, "deleted", nil)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) dispatchSchedules(w http.ResponseWriter, r *http.Request) {
	scope, ok := s.workflowScope(w, r, authz.PermWorkflowExecute)
	if !ok || !s.requireSchedules(w, r) {
		return
	}
	var req dispatchSchedulesRequest
	if r.ContentLength > 0 || r.Header.Get("Content-Type") != "" {
		if !DecodeJSON(w, r, &req) {
			return
		}
		if hostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
			return
		}
	}
	now := s.clock().UTC()
	due, err := s.schedules.ListDue(r.Context(), scope, now)
	if err != nil {
		writeScheduleStoreError(w, r, err)
		return
	}
	want := strings.TrimSpace(req.ScheduleID)
	out := scheduleDispatchResponse{Items: []scheduleDispatchItem{}}
	for _, rec := range due {
		if want != "" && rec.ID != want {
			continue
		}
		out.Items = append(out.Items, s.dispatchOneSchedule(r, scope, rec, now)...)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) dispatchOneSchedule(r *http.Request, scope isolation.Scope, rec schedule.Record, now time.Time) []scheduleDispatchItem {
	if rec.Status != schedule.StatusEnabled {
		next, _ := s.advanceSchedule(r, scope, rec, now, "disabled", "")
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "disabled", FireAt: timePtr(next)}}
	}
	ver, err := s.workflows.GetVersion(r.Context(), scope, rec.WorkflowID, rec.WorkflowVersionID)
	if err != nil {
		next, _ := s.advanceSchedule(r, scope, rec, now, "unpublished", err.Error())
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "unpublished", Error: "unpublished", FireAt: timePtr(next)}}
	}
	active := s.scheduleHasActive(r, scope, rec)
	plan, err := schedule.PlanFires(rec, now, active)
	if err != nil {
		next, _ := s.advanceSchedule(r, scope, rec, now, "invalid", err.Error())
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: "invalid", Error: err.Error(), FireAt: timePtr(next)}}
	}
	if plan.SkipReason != "" || len(plan.Fires) == 0 {
		_, _ = s.schedules.RecordFire(r.Context(), scope, now, rec.ID, schedule.FireUpdate{NextFireAt: plan.NextFireAt})
		return []scheduleDispatchItem{{ScheduleID: rec.ID, SkipReason: firstNonEmpty(plan.SkipReason, "not-due"), FireAt: timePtr(plan.NextFireAt)}}
	}
	var items []scheduleDispatchItem
	lastID := rec.LastExecutionID
	lastErr := ""
	var lastFired *time.Time
	for _, fireAt := range plan.Fires {
		item, execID, fireErr := s.startScheduleFire(r, scope, rec, ver, fireAt)
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
	_, _ = s.schedules.RecordFire(r.Context(), scope, now, rec.ID, schedule.FireUpdate{
		NextFireAt:      plan.NextFireAt,
		LastFiredAt:     lastFired,
		LastExecutionID: lastID,
		LastError:       lastErr,
	})
	return items
}

func (s *Server) startScheduleFire(r *http.Request, scope isolation.Scope, rec schedule.Record, ver wfstore.Version, fireAt time.Time) (scheduleDispatchItem, string, string) {
	item := scheduleDispatchItem{ScheduleID: rec.ID, FireAt: timePtr(fireAt.UTC())}
	idem := schedule.IdempotencyKey(rec.ID, fireAt)
	start := wfstore.StartInput{
		VersionID:      ver.ID,
		IdempotencyKey: idem,
		Input:          map[string]any{},
		CorrelationID:  RequestIDFromContext(r.Context()),
		TriggerID:      rec.ID,
		TriggerType:    schedule.TypeSchedule,
		RequestedBy:    firstNonEmpty(rec.CreatedBy, scope.ActorID()),
		PolicySnapshot: map[string]any{"triggerType": schedule.TypeSchedule, "scheduleId": rec.ID, "scheduleCreatedBy": rec.CreatedBy},
		HostContext:    map[string]any{"requestId": RequestIDFromContext(r.Context()), "scheduleId": rec.ID},
	}
	exec, replayed, err := s.dispatchScheduleExecution(r, scope, rec, ver, start)
	if err != nil {
		item.Error = err.Error()
		item.SkipReason = "start-failed"
		s.writeScheduleAudit(r, scope, rec, "denied", map[string]any{"reason": item.SkipReason, "fireAt": fireAt.UTC()})
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

func (s *Server) dispatchScheduleExecution(r *http.Request, scope isolation.Scope, rec schedule.Record, ver wfstore.Version, start wfstore.StartInput) (wfstore.Execution, bool, error) {
	workflowID := rec.WorkflowID
	if start.IdempotencyKey != "" {
		existing, peekErr := s.workflows.PeekIdempotent(r.Context(), scope, workflowID, start)
		if peekErr == nil {
			s.writeScheduleAudit(r, scope, rec, "replayed", map[string]any{"executionId": existing.ID})
			return existing, true, nil
		}
		if !errors.Is(peekErr, wfstore.ErrNotFound) {
			return wfstore.Execution{}, false, peekErr
		}
	}
	if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 && s.ops != nil {
		if _, err := s.ops.Resolve(r.Context(), scope, refs); err != nil {
			return wfstore.Execution{}, false, err
		}
	}
	if s.approvals != nil {
		eval, evalErr := s.evaluateVersion(r.Context(), scope, workflowID, ver.ID)
		if evalErr != nil {
			return wfstore.Execution{}, false, evalErr
		}
		if eval.Decision == policy.DecisionDeny {
			s.emitAlert(r, scope, opsalert.Signal{
				Kind:         opsalert.KindPolicy,
				Action:       "schedule.dispatch",
				ResourceType: "workflow_schedule",
				ResourceID:   rec.ID,
				Code:         CodeForbidden,
				Details:      map[string]any{"reason": "policy-deny"},
			})
			return wfstore.Execution{}, false, errPolicyDenied
		}
		if _, gateErr := s.dispatchApprovalsOK(r.Context(), scope, eval, workflowID, ver.ID); gateErr != nil {
			return wfstore.Execution{}, false, gateErr
		}
	}
	exec, err := s.workflows.StartExecution(r.Context(), scope, workflowID, start)
	if err != nil {
		return wfstore.Execution{}, false, err
	}
	if exec.Replayed {
		s.writeScheduleAudit(r, scope, rec, "replayed", map[string]any{"executionId": exec.ID})
		return exec, true, nil
	}
	if s.ops != nil {
		copied, copyErr := s.ops.CopyPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID)
		if copyErr != nil {
			return wfstore.Execution{}, false, copyErr
		}
		if len(copied) == 0 {
			if refs := opsconfig.ExtractRefs(ver.DefinitionYAML); len(refs) > 0 {
				if _, err := s.ops.CopyPins(r.Context(), scope, opsconfig.OwnerWorkflowVersion, ver.ID, opsconfig.OwnerExecution, exec.ID); err != nil {
					return wfstore.Execution{}, false, err
				}
			}
		}
	}
	s.writeScheduleAudit(r, scope, rec, "created", map[string]any{"executionId": exec.ID})
	return exec, false, nil
}

func (s *Server) scheduleHasActive(r *http.Request, scope isolation.Scope, rec schedule.Record) bool {
	items, err := s.workflows.ListExecutions(r.Context(), scope, wfstore.ExecutionListFilter{WorkflowID: rec.WorkflowID, Limit: 100})
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

func (s *Server) advanceSchedule(r *http.Request, scope isolation.Scope, rec schedule.Record, now time.Time, reason, lastErr string) (time.Time, error) {
	next, err := schedule.NextAfter(rec, now)
	if err != nil {
		return time.Time{}, err
	}
	_, err = s.schedules.RecordFire(r.Context(), scope, now, rec.ID, schedule.FireUpdate{NextFireAt: next, LastError: lastErr})
	s.writeScheduleAudit(r, scope, rec, "denied", map[string]any{"reason": reason})
	return next, err
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

func (s *Server) writeScheduleAudit(r *http.Request, scope isolation.Scope, rec schedule.Record, outcome string, extra map[string]any) {
	if s.workflows == nil {
		return
	}
	details := map[string]any{
		"scheduleId":        rec.ID,
		"workflowId":        rec.WorkflowID,
		"workflowVersionId": rec.WorkflowVersionID,
		"triggerType":       schedule.TypeSchedule,
		"correlationId":     RequestIDFromContext(r.Context()),
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
	_, _ = s.workflows.WriteAudit(r.Context(), scope, wfstore.AuditWrite{
		Action:        "execution.start",
		ResourceType:  resourceType,
		ResourceID:    resourceID,
		Outcome:       outcome,
		CorrelationID: RequestIDFromContext(r.Context()),
		HostContext:   map[string]any{"requestId": RequestIDFromContext(r.Context())},
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
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, schedule.ErrUnpublished):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Schedules must pin a published workflow version.")
	case errors.Is(err, schedule.ErrTimezone):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Schedule timezone must be a valid IANA name.")
	case errors.Is(err, schedule.ErrDisabled):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Schedule is disabled.")
	case errors.Is(err, schedule.ErrOverlap):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Schedule overlap was rejected.")
	case errors.Is(err, schedule.ErrInvalid), errors.Is(err, schedule.ErrNoScope):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Schedule configuration is invalid.")
	case errors.Is(err, schedule.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "A schedule with this identity already exists.")
	case errors.Is(err, schedule.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Schedule store is not available.")
	case errors.Is(err, errPolicyDenied):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Policy denied this dispatch.")
	case errors.Is(err, errApprovalRequired):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Dispatch requires a valid approval bound to the current workflow version, target, policy revision, and operation.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
