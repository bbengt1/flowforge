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

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu         sync.Mutex
	workflows  map[string]memWorkflow // id -> row
	versions   map[string][]Version   // workflow id -> versions
	executions map[string][]Execution // workflow id -> executions
}

// NewMemory returns an empty workflow store.
func NewMemory() *Memory {
	return &Memory{
		workflows:  map[string]memWorkflow{},
		versions:   map[string][]Version{},
		executions: map[string][]Execution{},
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
	if scope.Zero() {
		return Execution{}, ErrNoScope
	}
	if strings.TrimSpace(in.VersionID) == "" {
		return Execution{}, ErrDraftNotRunnable
	}
	if !authz.ValidUUID(in.VersionID) {
		return Execution{}, ErrInvalid
	}
	if _, err := m.lookup(scope, workflowID); err != nil {
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
	exec := Execution{
		ID:                newID(),
		WorkflowID:        workflowID,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Status:            ExecutionPinned,
		RequestedBy:       scope.ActorID(),
		CreatedAt:         time.Now().UTC(),
	}
	m.executions[workflowID] = append(m.executions[workflowID], exec)
	return exec, nil
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
			for _, exec := range m.executions[row.record.ID] {
				if exec.WorkflowVersionID != ver.ID {
					continue
				}
				if exec.Status != ExecutionQueued && exec.Status != ExecutionPinned {
					continue
				}
				out = append(out, CredentialRef{
					Kind:            CredentialRefExecution,
					WorkflowID:      row.record.ID,
					WorkflowSlug:    row.record.Slug,
					WorkflowName:    row.record.Name,
					VersionID:       ver.ID,
					VersionNumber:   ver.VersionNumber,
					ExecutionID:     exec.ID,
					ExecutionStatus: exec.Status,
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
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, exec := range m.executions[workflowID] {
		if exec.ID == executionID {
			return exec, nil
		}
	}
	return Execution{}, ErrNotFound
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
