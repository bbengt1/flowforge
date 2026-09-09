package wfstore

import (
	"context"
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

type memWorkflow struct {
	workspaceID string
	record      Workflow
	draft       Draft
}

type memExecution struct {
	workspaceID string
	record      Execution
	fingerprint string
	steps       []ExecutionStep
	jobs        []ExecutionJob
}

type memAudit struct {
	workspaceID string
	record      AuditEvent
}

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu         sync.Mutex
	workflows  map[string]memWorkflow  // id -> row
	versions   map[string][]Version    // workflow id -> versions
	executions map[string]memExecution // execution id -> row
	audits     []memAudit
}

// NewMemory returns an empty workflow store.
func NewMemory() *Memory {
	return &Memory{
		workflows:  map[string]memWorkflow{},
		versions:   map[string][]Version{},
		executions: map[string]memExecution{},
	}
}

func (m *Memory) Create(_ context.Context, scope isolation.Scope, in CreateInput) (Workflow, Draft, error) {
	if scope.Zero() {
		return Workflow{}, Draft{}, ErrNoScope
	}
	if err := validateCreate(in); err != nil {
		return Workflow{}, Draft{}, err
	}
	now := time.Now().UTC()
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = in.Summary.Name
	}
	slug := strings.TrimSpace(in.Slug)
	if slug == "" {
		slug = in.Summary.Name
	}
	wf := Workflow{
		ID:            newID(),
		Slug:          slug,
		Name:          name,
		Status:        StatusDraft,
		DraftRevision: 1,
		DraftDigest:   in.Digest,
		CreatedBy:     scope.ActorID(),
		UpdatedBy:     scope.ActorID(),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	draft := Draft{
		WorkflowID:      wf.ID,
		Revision:        1,
		DefinitionYAML:  in.NormalizedYAML,
		Digest:          in.Digest,
		Summary:         in.Summary,
		Warnings:        []workflow.FieldError{},
		ValidationState: ValidationValid,
		UpdatedBy:       scope.ActorID(),
		UpdatedAt:       now,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.workflows {
		if existing.workspaceID == scope.WorkspaceID() && existing.record.Slug == slug {
			return Workflow{}, Draft{}, ErrConflict
		}
	}
	m.workflows[wf.ID] = memWorkflow{workspaceID: scope.WorkspaceID(), record: wf, draft: draft}
	return wf, draft, nil
}

func (m *Memory) List(_ context.Context, scope isolation.Scope) ([]Workflow, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Workflow
	for _, row := range m.workflows {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		out = append(out, publicWorkflow(row))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].Slug < out[j].Slug
		}
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	if out == nil {
		out = []Workflow{}
	}
	return out, nil
}

func (m *Memory) Get(_ context.Context, scope isolation.Scope, id string) (Workflow, error) {
	row, err := m.lookup(scope, id)
	if err != nil {
		return Workflow{}, err
	}
	return publicWorkflow(row), nil
}

func (m *Memory) GetDraft(_ context.Context, scope isolation.Scope, workflowID string) (Draft, error) {
	row, err := m.lookup(scope, workflowID)
	if err != nil {
		return Draft{}, err
	}
	return cloneDraft(row.draft), nil
}

func (m *Memory) SaveDraft(_ context.Context, scope isolation.Scope, workflowID string, in SaveInput) (Workflow, Draft, error) {
	if scope.Zero() {
		return Workflow{}, Draft{}, ErrNoScope
	}
	if err := validateNormalized(in.NormalizedYAML, in.Digest, in.Summary); err != nil {
		return Workflow{}, Draft{}, err
	}
	if in.ExpectedRevision < 1 {
		return Workflow{}, Draft{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.workflows[workflowID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Workflow{}, Draft{}, ErrNotFound
	}
	if row.draft.Revision != in.ExpectedRevision {
		return Workflow{}, Draft{}, ErrRevisionConflict
	}
	now := time.Now().UTC()
	row.draft.Revision++
	row.draft.DefinitionYAML = in.NormalizedYAML
	row.draft.Digest = in.Digest
	row.draft.Summary = in.Summary
	row.draft.Warnings = []workflow.FieldError{}
	row.draft.ValidationState = ValidationValid
	row.draft.UpdatedBy = scope.ActorID()
	row.draft.UpdatedAt = now
	row.record.Name = firstNonEmpty(in.Summary.Name, row.record.Name)
	row.record.DraftRevision = row.draft.Revision
	row.record.DraftDigest = in.Digest
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = now
	m.workflows[workflowID] = row
	return publicWorkflow(row), cloneDraft(row.draft), nil
}

func (m *Memory) Publish(_ context.Context, scope isolation.Scope, workflowID string, in PublishInput) (Workflow, Version, error) {
	if scope.Zero() {
		return Workflow{}, Version{}, ErrNoScope
	}
	if strings.TrimSpace(in.Note) != in.Note || len(in.Note) > 2000 {
		return Workflow{}, Version{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.workflows[workflowID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Workflow{}, Version{}, ErrNotFound
	}
	if in.ExpectedRevision > 0 && row.draft.Revision != in.ExpectedRevision {
		return Workflow{}, Version{}, ErrRevisionConflict
	}
	for _, ver := range m.versions[workflowID] {
		if ver.Digest == row.draft.Digest {
			return Workflow{}, Version{}, ErrDuplicateVersion
		}
	}
	next := len(m.versions[workflowID]) + 1
	now := time.Now().UTC()
	ver := Version{
		ID:             newID(),
		WorkflowID:     workflowID,
		VersionNumber:  next,
		DefinitionYAML: row.draft.DefinitionYAML,
		Digest:         row.draft.Digest,
		Summary:        row.draft.Summary,
		PublishNote:    in.Note,
		PublishedBy:    scope.ActorID(),
		PublishedAt:    now,
	}
	m.versions[workflowID] = append(m.versions[workflowID], ver)
	row.record.Status = StatusPublished
	row.record.LatestVersionNumber = ver.VersionNumber
	row.record.LatestVersionID = ver.ID
	row.record.LatestVersionDigest = ver.Digest
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = now
	m.workflows[workflowID] = row
	return publicWorkflow(row), ver, nil
}

func (m *Memory) ListVersions(_ context.Context, scope isolation.Scope, workflowID string) ([]Version, error) {
	if _, err := m.lookup(scope, workflowID); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	src := m.versions[workflowID]
	out := make([]Version, len(src))
	copy(out, src)
	sort.Slice(out, func(i, j int) bool { return out[i].VersionNumber > out[j].VersionNumber })
	if out == nil {
		out = []Version{}
	}
	return out, nil
}

func (m *Memory) GetVersion(_ context.Context, scope isolation.Scope, workflowID, versionID string) (Version, error) {
	if _, err := m.lookup(scope, workflowID); err != nil {
		return Version{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ver := range m.versions[workflowID] {
		if ver.ID == versionID {
			return ver, nil
		}
	}
	return Version{}, ErrNotFound
}

func (m *Memory) Compare(_ context.Context, scope isolation.Scope, workflowID string, left, right CompareRef) (CompareResult, error) {
	row, err := m.lookup(scope, workflowID)
	if err != nil {
		return CompareResult{}, err
	}
	leftDoc, leftRef, err := m.resolveCompare(workflowID, left, row.draft)
	if err != nil {
		return CompareResult{}, err
	}
	rightDoc, rightRef, err := m.resolveCompare(workflowID, right, row.draft)
	if err != nil {
		return CompareResult{}, err
	}
	return compareDefinitions(leftRef, rightRef, leftDoc.yaml, rightDoc.yaml, leftDoc.digest, rightDoc.digest, leftDoc.summary, rightDoc.summary), nil
}

func (m *Memory) Restore(_ context.Context, scope isolation.Scope, workflowID string, in RestoreInput) (Workflow, Draft, error) {
	if scope.Zero() {
		return Workflow{}, Draft{}, ErrNoScope
	}
	if !authz.ValidUUID(in.VersionID) {
		return Workflow{}, Draft{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.workflows[workflowID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Workflow{}, Draft{}, ErrNotFound
	}
	if in.ExpectedRevision > 0 && row.draft.Revision != in.ExpectedRevision {
		return Workflow{}, Draft{}, ErrRevisionConflict
	}
	var src Version
	found := false
	for _, ver := range m.versions[workflowID] {
		if ver.ID == in.VersionID {
			src = ver
			found = true
			break
		}
	}
	if !found {
		return Workflow{}, Draft{}, ErrNotFound
	}
	now := time.Now().UTC()
	row.draft.Revision++
	row.draft.DefinitionYAML = src.DefinitionYAML
	row.draft.Digest = src.Digest
	row.draft.Summary = src.Summary
	row.draft.Warnings = []workflow.FieldError{}
	row.draft.ValidationState = ValidationValid
	row.draft.UpdatedBy = scope.ActorID()
	row.draft.UpdatedAt = now
	row.record.Name = firstNonEmpty(src.Summary.Name, row.record.Name)
	row.record.DraftRevision = row.draft.Revision
	row.record.DraftDigest = src.Digest
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = now
	m.workflows[workflowID] = row
	return publicWorkflow(row), cloneDraft(row.draft), nil
}

func (m *Memory) StartExecution(_ context.Context, scope isolation.Scope, workflowID string, in StartInput) (Execution, error) {
	prepared, err := prepareStart(scope, workflowID, in)
	if err != nil {
		return Execution{}, err
	}
	row, err := m.lookup(scope, workflowID)
	if err != nil {
		return Execution{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var ver Version
	found := false
	for _, candidate := range m.versions[workflowID] {
		if candidate.ID == in.VersionID {
			ver = candidate
			found = true
			break
		}
	}
	if !found {
		return Execution{}, ErrNotFound
	}
	if prepared.key != "" {
		if existing, ok, err := m.peekLocked(scope, workflowID, ver.ID, prepared); err != nil {
			return Execution{}, err
		} else if ok {
			return existing, nil
		}
	}
	now := time.Now().UTC()
	exec := Execution{
		ID:                newID(),
		WorkflowID:        workflowID,
		WorkflowSlug:      row.record.Slug,
		WorkflowName:      row.record.Name,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		TriggerID:         strings.TrimSpace(in.TriggerID),
		Status:            ExecutionQueued,
		IdempotencyKey:    prepared.key,
		Input:             prepared.input,
		PolicySnapshot:    prepared.policy,
		CorrelationID:     strings.TrimSpace(in.CorrelationID),
		RequestedBy:       scope.ActorID(),
		CreatedAt:         now,
		UpdatedAt:         now,
		RetentionUntil:    now.Add(DefaultExecutionRetention),
	}
	steps, jobs := materializePlan(exec.ID, planNodes(ver.DefinitionYAML, ver.Summary), now)
	m.executions[exec.ID] = memExecution{
		workspaceID: scope.WorkspaceID(),
		record:      exec,
		fingerprint: prepared.fingerprint,
		steps:       steps,
		jobs:        jobs,
	}
	m.audits = append(m.audits, memAudit{
		workspaceID: scope.WorkspaceID(),
		record: newAudit(scope, AuditWrite{
			Action:        "execution.start",
			ResourceType:  "execution",
			ResourceID:    exec.ID,
			Outcome:       "created",
			CorrelationID: exec.CorrelationID,
			HostContext:   in.HostContext,
			Details: map[string]any{
				"workflowId":        workflowID,
				"workflowVersionId": ver.ID,
			},
		}, now),
	})
	return cloneExecution(exec, row.record), nil
}

func (m *Memory) PeekIdempotent(_ context.Context, scope isolation.Scope, workflowID string, in StartInput) (Execution, error) {
	prepared, err := prepareStart(scope, workflowID, in)
	if err != nil {
		return Execution{}, err
	}
	if prepared.key == "" {
		return Execution{}, ErrNotFound
	}
	if _, err := m.lookup(scope, workflowID); err != nil {
		return Execution{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok, err := m.peekLocked(scope, workflowID, in.VersionID, prepared)
	if err != nil {
		return Execution{}, err
	}
	if !ok {
		return Execution{}, ErrNotFound
	}
	return exec, nil
}

func (m *Memory) peekLocked(scope isolation.Scope, workflowID, versionID string, prepared preparedStart) (Execution, bool, error) {
	for _, existing := range m.executions {
		if existing.workspaceID != scope.WorkspaceID() {
			continue
		}
		if existing.record.WorkflowID != workflowID || existing.record.WorkflowVersionID != versionID || existing.record.IdempotencyKey != prepared.key {
			continue
		}
		if existing.fingerprint != prepared.fingerprint {
			return Execution{}, false, ErrIdempotencyConflict
		}
		wf := m.workflows[existing.record.WorkflowID]
		out := cloneExecution(existing.record, wf.record)
		out.Replayed = true
		return out, true, nil
	}
	return Execution{}, false, nil
}

func (m *Memory) FindCredentialRefs(_ context.Context, scope isolation.Scope, credentialID string) ([]CredentialRef, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(credentialID) {
		return []CredentialRef{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []CredentialRef
	for _, row := range m.workflows {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if strings.Contains(row.draft.DefinitionYAML, credentialID) {
			out = append(out, CredentialRef{
				Kind:         CredentialRefDraft,
				WorkflowID:   row.record.ID,
				WorkflowSlug: row.record.Slug,
				WorkflowName: row.record.Name,
			})
		}
		for _, ver := range m.versions[row.record.ID] {
			if !strings.Contains(ver.DefinitionYAML, credentialID) {
				continue
			}
			out = append(out, CredentialRef{
				Kind:          CredentialRefVersion,
				WorkflowID:    row.record.ID,
				WorkflowSlug:  row.record.Slug,
				WorkflowName:  row.record.Name,
				VersionID:     ver.ID,
				VersionNumber: ver.VersionNumber,
			})
			for _, exec := range m.executions {
				if exec.workspaceID != scope.WorkspaceID() || exec.record.WorkflowID != row.record.ID {
					continue
				}
				if exec.record.WorkflowVersionID != ver.ID {
					continue
				}
				if !isActiveExecution(exec.record.Status) {
					continue
				}
				out = append(out, CredentialRef{
					Kind:            CredentialRefExecution,
					WorkflowID:      row.record.ID,
					WorkflowSlug:    row.record.Slug,
					WorkflowName:    row.record.Name,
					VersionID:       ver.ID,
					VersionNumber:   ver.VersionNumber,
					ExecutionID:     exec.record.ID,
					ExecutionStatus: exec.record.Status,
				})
			}
		}
	}
	if out == nil {
		out = []CredentialRef{}
	}
	return out, nil
}

func (m *Memory) GetExecution(_ context.Context, scope isolation.Scope, workflowID, executionID string) (Execution, error) {
	if _, err := m.lookup(scope, workflowID); err != nil {
		return Execution{}, err
	}
	exec, err := m.GetExecutionByID(context.Background(), scope, executionID)
	if err != nil {
		return Execution{}, err
	}
	if exec.WorkflowID != workflowID {
		return Execution{}, ErrNotFound
	}
	return exec, nil
}

func (m *Memory) GetExecutionByID(_ context.Context, scope isolation.Scope, executionID string) (Execution, error) {
	if scope.Zero() {
		return Execution{}, ErrNoScope
	}
	if !authz.ValidUUID(executionID) {
		return Execution{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return Execution{}, ErrNotFound
	}
	wf := m.workflows[exec.record.WorkflowID]
	return cloneExecution(exec.record, wf.record), nil
}

func (m *Memory) ListExecutions(_ context.Context, scope isolation.Scope, filter ExecutionListFilter) ([]Execution, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if filter.WorkflowID != "" {
		if _, err := m.lookup(scope, filter.WorkflowID); err != nil {
			return nil, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Execution
	for _, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() {
			continue
		}
		if filter.WorkflowID != "" && exec.record.WorkflowID != filter.WorkflowID {
			continue
		}
		if filter.Status != "" && exec.record.Status != filter.Status {
			continue
		}
		wf := m.workflows[exec.record.WorkflowID]
		out = append(out, cloneExecution(exec.record, wf.record))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	limit := listLimit(filter.Limit)
	if len(out) > limit {
		out = out[:limit]
	}
	if out == nil {
		out = []Execution{}
	}
	return out, nil
}

func (m *Memory) ListSteps(_ context.Context, scope isolation.Scope, executionID string) ([]ExecutionStep, error) {
	exec, err := m.requireExecution(scope, executionID)
	if err != nil {
		return nil, err
	}
	out := make([]ExecutionStep, len(exec.steps))
	copy(out, exec.steps)
	if out == nil {
		out = []ExecutionStep{}
	}
	return out, nil
}

func (m *Memory) GetStep(_ context.Context, scope isolation.Scope, executionID, stepID string) (ExecutionStep, error) {
	exec, err := m.requireExecution(scope, executionID)
	if err != nil {
		return ExecutionStep{}, err
	}
	for _, step := range exec.steps {
		if step.ID == stepID {
			return step, nil
		}
	}
	return ExecutionStep{}, ErrNotFound
}

func (m *Memory) ListJobs(_ context.Context, scope isolation.Scope, executionID string) ([]ExecutionJob, error) {
	exec, err := m.requireExecution(scope, executionID)
	if err != nil {
		return nil, err
	}
	out := make([]ExecutionJob, len(exec.jobs))
	copy(out, exec.jobs)
	if out == nil {
		out = []ExecutionJob{}
	}
	return out, nil
}

func (m *Memory) ListAuditEvents(_ context.Context, scope isolation.Scope, filter AuditListFilter) ([]AuditEvent, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []AuditEvent
	for _, row := range m.audits {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if filter.ResourceType != "" && row.record.ResourceType != filter.ResourceType {
			continue
		}
		if filter.ResourceID != "" && row.record.ResourceID != filter.ResourceID {
			continue
		}
		if filter.Action != "" && row.record.Action != filter.Action {
			continue
		}
		out = append(out, row.record)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].OccurredAt.After(out[j].OccurredAt)
	})
	limit := listLimit(filter.Limit)
	if len(out) > limit {
		out = out[:limit]
	}
	if out == nil {
		out = []AuditEvent{}
	}
	return out, nil
}

func (m *Memory) WriteAudit(_ context.Context, scope isolation.Scope, in AuditWrite) (AuditEvent, error) {
	if scope.Zero() {
		return AuditEvent{}, ErrNoScope
	}
	ev := newAudit(scope, in, time.Now().UTC())
	m.mu.Lock()
	defer m.mu.Unlock()
	m.audits = append(m.audits, memAudit{workspaceID: scope.WorkspaceID(), record: ev})
	return ev, nil
}

func (m *Memory) PurgeExpired(_ context.Context, scope isolation.Scope, now time.Time) (int, int, error) {
	if scope.Zero() {
		return 0, 0, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	execs := 0
	for id, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() {
			continue
		}
		if exec.record.RetentionUntil.After(now) {
			continue
		}
		if !isTerminalExecution(exec.record.Status) && exec.record.Status != ExecutionQueued {
			continue
		}
		delete(m.executions, id)
		execs++
	}
	kept := m.audits[:0]
	audits := 0
	for _, row := range m.audits {
		if row.workspaceID == scope.WorkspaceID() && !row.record.RetentionUntil.After(now) {
			audits++
			continue
		}
		kept = append(kept, row)
	}
	m.audits = kept
	return execs, audits, nil
}

func (m *Memory) requireExecution(scope isolation.Scope, executionID string) (memExecution, error) {
	if scope.Zero() {
		return memExecution{}, ErrNoScope
	}
	if !authz.ValidUUID(executionID) {
		return memExecution{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return memExecution{}, ErrNotFound
	}
	return exec, nil
}

type compareDoc struct {
	yaml    string
	digest  string
	summary workflow.Summary
}

func (m *Memory) resolveCompare(workflowID string, ref CompareRef, draft Draft) (compareDoc, CompareRef, error) {
	switch strings.TrimSpace(ref.Kind) {
	case RefDraft, "":
		if ref.Kind == "" {
			ref.Kind = RefDraft
		}
		if ref.VersionID != "" || ref.VersionNumber != 0 {
			return compareDoc{}, CompareRef{}, ErrInvalid
		}
		return compareDoc{yaml: draft.DefinitionYAML, digest: draft.Digest, summary: draft.Summary}, CompareRef{Kind: RefDraft}, nil
	case RefVersion:
		m.mu.Lock()
		defer m.mu.Unlock()
		for _, ver := range m.versions[workflowID] {
			if (ref.VersionID != "" && ver.ID == ref.VersionID) || (ref.VersionID == "" && ref.VersionNumber > 0 && ver.VersionNumber == ref.VersionNumber) {
				return compareDoc{yaml: ver.DefinitionYAML, digest: ver.Digest, summary: ver.Summary}, CompareRef{Kind: RefVersion, VersionID: ver.ID, VersionNumber: ver.VersionNumber}, nil
			}
		}
		return compareDoc{}, CompareRef{}, ErrNotFound
	default:
		return compareDoc{}, CompareRef{}, ErrInvalid
	}
}

func (m *Memory) lookup(scope isolation.Scope, id string) (memWorkflow, error) {
	if scope.Zero() {
		return memWorkflow{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return memWorkflow{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.workflows[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return memWorkflow{}, ErrNotFound
	}
	return row, nil
}

func publicWorkflow(row memWorkflow) Workflow {
	wf := row.record
	wf.DraftRevision = row.draft.Revision
	wf.DraftDigest = row.draft.Digest
	return wf
}

func cloneDraft(d Draft) Draft {
	out := d
	if out.Warnings == nil {
		out.Warnings = []workflow.FieldError{}
	}
	return out
}

func validateCreate(in CreateInput) error {
	if err := validateNormalized(in.NormalizedYAML, in.Digest, in.Summary); err != nil {
		return err
	}
	slug := strings.TrimSpace(in.Slug)
	if slug != "" && !authz.ValidTenantSlug(slug) {
		return ErrInvalid
	}
	name := strings.TrimSpace(in.Name)
	if name != "" && (len(name) < 1 || len(name) > 200) {
		return ErrInvalid
	}
	return nil
}

func validateNormalized(yamlDoc, digest string, summary workflow.Summary) error {
	if strings.TrimSpace(yamlDoc) == "" || len(yamlDoc) > 262144 {
		return ErrInvalid
	}
	if !strings.HasPrefix(digest, "sha256:") || len(digest) != len("sha256:")+64 {
		return ErrInvalid
	}
	if workflow.Digest(yamlDoc) != digest {
		return ErrInvalid
	}
	if strings.TrimSpace(summary.Name) == "" {
		return ErrInvalid
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
