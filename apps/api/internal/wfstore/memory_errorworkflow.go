package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// Memory twin of the #649 S3 workspace error workflow.

func (m *Memory) GetErrorWorkflow(_ context.Context, scope isolation.Scope) (ErrorWorkflowSetting, bool, error) {
	if scope.Zero() {
		return ErrorWorkflowSetting{}, false, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	id := m.errorWorkflows[scope.WorkspaceID()]
	if id == "" {
		return ErrorWorkflowSetting{}, false, nil
	}
	out := ErrorWorkflowSetting{WorkflowID: id}
	if wf, ok := m.workflows[id]; ok && wf.workspaceID == scope.WorkspaceID() {
		out.WorkflowName = wf.record.Name
		out.WorkflowSlug = wf.record.Slug
	}
	return out, true, nil
}

func (m *Memory) SetErrorWorkflow(_ context.Context, scope isolation.Scope, workflowID string, actor AuditActor) (ErrorWorkflowSetting, error) {
	if err := adminScope(scope); err != nil {
		return ErrorWorkflowSetting{}, err
	}
	workflowID = strings.TrimSpace(workflowID)
	if !authz.ValidUUID(workflowID) {
		return ErrorWorkflowSetting{}, ErrErrorWorkflowTarget
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	wf, ok := m.workflows[workflowID]
	if !ok || wf.workspaceID != scope.WorkspaceID() {
		return ErrorWorkflowSetting{}, ErrErrorWorkflowTarget
	}
	if errorTargetSkip(true, wf.deletedAt != nil, wf.record.Status, m.latestVersionLocked(workflowID)) != "" {
		return ErrorWorkflowSetting{}, ErrErrorWorkflowTarget
	}
	if m.errorWorkflows == nil {
		m.errorWorkflows = map[string]string{}
	}
	previous := m.errorWorkflows[scope.WorkspaceID()]
	m.errorWorkflows[scope.WorkspaceID()] = workflowID
	m.appendAuditLocked(scope, errorWorkflowSetAudit(scope, actor, wf.record, previous), time.Now().UTC())
	return ErrorWorkflowSetting{WorkflowID: workflowID, WorkflowName: wf.record.Name, WorkflowSlug: wf.record.Slug}, nil
}

func (m *Memory) ClearErrorWorkflow(_ context.Context, scope isolation.Scope, actor AuditActor) (bool, error) {
	if err := adminScope(scope); err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.errorWorkflows[scope.WorkspaceID()]
	if previous == "" {
		return false, nil
	}
	delete(m.errorWorkflows, scope.WorkspaceID())
	m.appendAuditLocked(scope, errorWorkflowClearedAudit(scope, actor, previous), time.Now().UTC())
	return true, nil
}

func (m *Memory) latestVersionLocked(workflowID string) *Version {
	var best *Version
	for i := range m.versions[workflowID] {
		v := m.versions[workflowID][i]
		if best == nil || v.VersionNumber > best.VersionNumber {
			best = &v
		}
	}
	return best
}

// fireErrorWorkflowLocked is fireErrorWorkflowTx under m.mu. exec is the
// parent after its status moved from prevStatus.
func (m *Memory) fireErrorWorkflowLocked(exec *memExecution, prevStatus string, now time.Time) {
	next := exec.record.Status
	if prevStatus == next || (next != ExecutionFailed && next != ExecutionIndeterminate) {
		return
	}
	target := m.errorWorkflows[exec.workspaceID]
	if target == "" {
		return
	}
	if wf, ok := m.workflows[exec.record.WorkflowID]; !ok || wf.deletedAt != nil {
		return
	}
	if !errorParentEligible(ExecutionTriggerType(exec.record), exec.record.ErrorParentID, exec.operatorRetried) {
		return
	}
	sys, err := isolation.AuthorizeSystem(exec.workspaceID)
	if err != nil {
		return
	}
	var pinned Version
	for _, v := range m.versions[exec.record.WorkflowID] {
		if v.ID == exec.record.WorkflowVersionID {
			pinned = v
		}
	}
	fire, reason, skip, cause := errorWorkflowDecision(next, exec.steps, pinned.DefinitionYAML)
	if !fire {
		if skip != "" {
			m.appendAuditLocked(sys, errorSkippedAudit(exec.record, target, skip), now)
		}
		return
	}
	wf, found := m.workflows[target]
	if found && wf.workspaceID != exec.workspaceID {
		found = false
	}
	var ver *Version
	if found {
		ver = m.latestVersionLocked(target)
	}
	if skip := errorTargetSkip(found, found && wf.deletedAt != nil, wf.record.Status, ver); skip != "" {
		m.appendAuditLocked(sys, errorSkippedAudit(exec.record, target, skip), now)
		return
	}
	skip = ErrorSkipPolicyUnavailable
	if m.errorGate != nil {
		skip = m.errorGate(context.Background(), nil, sys, *ver)
	}
	if skip != "" {
		m.appendAuditLocked(sys, errorSkippedAudit(exec.record, target, skip), now)
		return
	}
	for _, other := range m.executions {
		if other.workspaceID == exec.workspaceID && other.record.ErrorParentID == exec.record.ID {
			return // already fired
		}
	}
	if m.errorOpenCap > 0 {
		open := 0
		for _, other := range m.executions {
			if other.workspaceID == exec.workspaceID && other.record.ID != exec.record.ID && !isTerminalExecution(other.record.Status) {
				open++
			}
		}
		if open >= m.errorOpenCap {
			m.appendAuditLocked(sys, errorSkippedAudit(exec.record, target, ErrorSkipCapReached), now)
			return
		}
	}
	// Everything that can fail runs before the first write, so a failure
	// leaves no partial run (the Postgres savepoint's twin) and is audited
	// as start_failed; the parent's status is already final.
	startFailed := func() { m.appendAuditLocked(sys, errorSkippedAudit(exec.record, target, ErrorSkipStartFailed), now) }
	payload, err := boundInput(errorWorkflowPayload(exec.record, pinned.VersionNumber, reason, cause))
	if err != nil {
		startFailed()
		return
	}
	child := Execution{
		ID:                newID(),
		WorkflowID:        target,
		WorkflowSlug:      wf.record.Slug,
		WorkflowName:      wf.record.Name,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Status:            ExecutionQueued,
		Input:             redactObject(payload),
		PolicySnapshot:    errorRunPolicy(*ver),
		CorrelationID:     exec.record.CorrelationID,
		ErrorParentID:     exec.record.ID,
		CreatedAt:         now,
		UpdatedAt:         now,
		RetentionUntil:    now.Add(DefaultExecutionRetention),
	}
	nodes, edges, err := planGraph(ver.DefinitionYAML, ver.Summary)
	if err == nil {
		err = errorFireFault()
	}
	if err != nil {
		startFailed()
		return
	}
	steps, jobs := materializePlan(child.ID, nodes, edges, now)
	m.executions[child.ID] = memExecution{
		workspaceID: exec.workspaceID,
		record:      child,
		steps:       steps,
		jobs:        jobs,
		edges:       edges,
	}
	m.appendAuditLocked(sys, AuditWrite{
		Action:        "execution.start",
		ResourceType:  "execution",
		ResourceID:    child.ID,
		Outcome:       "created",
		CorrelationID: child.CorrelationID,
		Details:       startAuditDetails(target, *ver, child, "created"),
	}, now)
	m.appendAuditLocked(sys, errorFiredAudit(exec.record, child, target, reason, cause), now)
}

// SetErrorWorkflowGate installs the Memory store's pre-start policy gate
// (nil skips every fire with policy_unavailable). The gate runs under the
// store lock and must not call back into this store.
// SetErrorWorkflowOpenCap sets the open-run cap applied to error runs
// (n <= 0 unlimited), mirroring SetErrorWorkflowOpenCap for Postgres.
func (m *Memory) SetErrorWorkflowOpenCap(n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.errorOpenCap = n
}

func (m *Memory) SetErrorWorkflowGate(g ErrorWorkflowGate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.errorGate = g
}
