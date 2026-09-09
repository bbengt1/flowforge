package opsconfig

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
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

type memoryResource struct {
	workspaceID string
	record      Resource
	draft       Draft
	versions    []Version
}

type memoryPin struct {
	workspaceID string
	ownerKind   string
	ownerID     string
	pin         Pin
}

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu        sync.Mutex
	resources map[string]*memoryResource
	pins      []memoryPin
}

// NewMemory returns an empty in-process ops-config store.
func NewMemory() *Memory {
	return &Memory{resources: map[string]*memoryResource{}}
}

func (m *Memory) Create(_ context.Context, scope isolation.Scope, in CreateInput) (Resource, Draft, error) {
	if scope.Zero() {
		return Resource{}, Draft{}, ErrNoScope
	}
	if !ValidKind(in.Kind) {
		return Resource{}, Draft{}, fmt.Errorf("%w: unknown kind", ErrInvalid)
	}
	name, err := normalizeName(in.Name)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	slug, err := normalizeSlug(in.Slug, name)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	spec, digest, err := NormalizeSpec(in.Kind, in.Spec)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, row := range m.resources {
		if row.workspaceID == scope.WorkspaceID() && row.record.Kind == in.Kind && row.record.Slug == slug {
			return Resource{}, Draft{}, ErrConflict
		}
	}
	now := time.Now().UTC()
	id := newID()
	rec := Resource{
		ID:            id,
		Kind:          in.Kind,
		Slug:          slug,
		Name:          name,
		Status:        StatusDraft,
		DraftRevision: 1,
		DraftDigest:   digest,
		CredentialID:  credentialIDFromSpec(spec),
		PolicyID:      policyIDFromSpec(spec),
		CreatedBy:     scope.ActorID(),
		UpdatedBy:     scope.ActorID(),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	draft := Draft{
		ResourceID: id,
		Kind:       in.Kind,
		Revision:   1,
		Spec:       spec,
		Digest:     digest,
		UpdatedBy:  scope.ActorID(),
		UpdatedAt:  now,
	}
	m.resources[id] = &memoryResource{workspaceID: scope.WorkspaceID(), record: rec, draft: draft}
	return rec, draft, nil
}

func (m *Memory) List(_ context.Context, scope isolation.Scope, kind string) ([]Resource, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if kind != "" && !ValidKind(kind) {
		return nil, fmt.Errorf("%w: unknown kind", ErrInvalid)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Resource
	for _, row := range m.resources {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if kind != "" && row.record.Kind != kind {
			continue
		}
		out = append(out, cloneResource(row.record))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].Name < out[j].Name
		}
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	if out == nil {
		out = []Resource{}
	}
	return out, nil
}

func (m *Memory) Get(_ context.Context, scope isolation.Scope, kind, id string) (Resource, error) {
	row, err := m.lookup(scope, kind, id)
	if err != nil {
		return Resource{}, err
	}
	return cloneResource(row.record), nil
}

func (m *Memory) GetDraft(_ context.Context, scope isolation.Scope, kind, id string) (Draft, error) {
	row, err := m.lookup(scope, kind, id)
	if err != nil {
		return Draft{}, err
	}
	return cloneDraft(row.draft), nil
}

func (m *Memory) SaveDraft(_ context.Context, scope isolation.Scope, kind, id string, in SaveInput) (Resource, Draft, error) {
	if in.ExpectedRevision < 1 {
		return Resource{}, Draft{}, fmt.Errorf("%w: revision is required", ErrInvalid)
	}
	row, err := m.lookup(scope, kind, id)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err = m.lookupLocked(scope, kind, id)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	if row.draft.Revision != in.ExpectedRevision {
		return Resource{}, Draft{}, ErrRevisionConflict
	}
	name := row.record.Name
	if strings.TrimSpace(in.Name) != "" {
		name, err = normalizeName(in.Name)
		if err != nil {
			return Resource{}, Draft{}, err
		}
	}
	spec, digest, err := NormalizeSpec(kind, in.Spec)
	if err != nil {
		return Resource{}, Draft{}, err
	}
	now := time.Now().UTC()
	row.draft.Revision++
	row.draft.Spec = spec
	row.draft.Digest = digest
	row.draft.UpdatedBy = scope.ActorID()
	row.draft.UpdatedAt = now
	row.record.Name = name
	row.record.DraftRevision = row.draft.Revision
	row.record.DraftDigest = digest
	row.record.CredentialID = credentialIDFromSpec(spec)
	row.record.PolicyID = policyIDFromSpec(spec)
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = now
	return cloneResource(row.record), cloneDraft(row.draft), nil
}

func (m *Memory) Publish(_ context.Context, scope isolation.Scope, kind, id string, in PublishInput) (Resource, Version, error) {
	if strings.TrimSpace(in.Note) != in.Note || len(in.Note) > 2000 {
		return Resource{}, Version{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, kind, id)
	if err != nil {
		return Resource{}, Version{}, err
	}
	if row.record.Status == StatusDisabled {
		return Resource{}, Version{}, ErrDisabled
	}
	if in.ExpectedRevision > 0 && row.draft.Revision != in.ExpectedRevision {
		return Resource{}, Version{}, ErrRevisionConflict
	}
	for _, ver := range row.versions {
		if ver.Digest == row.draft.Digest {
			return Resource{}, Version{}, ErrConflict
		}
	}
	now := time.Now().UTC()
	ver := Version{
		ID:            newID(),
		ResourceID:    row.record.ID,
		Kind:          kind,
		VersionNumber: len(row.versions) + 1,
		Spec:          cloneMap(row.draft.Spec),
		Digest:        row.draft.Digest,
		PublishNote:   in.Note,
		PublishedBy:   scope.ActorID(),
		PublishedAt:   now,
	}
	row.versions = append(row.versions, ver)
	row.record.Status = StatusPublished
	row.record.LatestVersionNumber = ver.VersionNumber
	row.record.LatestVersionID = ver.ID
	row.record.LatestVersionDigest = ver.Digest
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = now
	return cloneResource(row.record), cloneVersion(ver), nil
}

func (m *Memory) ListVersions(_ context.Context, scope isolation.Scope, kind, id string) ([]Version, error) {
	row, err := m.lookup(scope, kind, id)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Version, 0, len(row.versions))
	for i := len(row.versions) - 1; i >= 0; i-- {
		out = append(out, cloneVersion(row.versions[i]))
	}
	return out, nil
}

func (m *Memory) GetVersion(_ context.Context, scope isolation.Scope, kind, id, versionID string) (Version, error) {
	row, err := m.lookup(scope, kind, id)
	if err != nil {
		return Version{}, err
	}
	if !authz.ValidUUID(versionID) {
		return Version{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ver := range row.versions {
		if ver.ID == versionID {
			return cloneVersion(ver), nil
		}
	}
	return Version{}, ErrNotFound
}

func (m *Memory) Disable(_ context.Context, scope isolation.Scope, kind, id string) (Resource, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, kind, id)
	if err != nil {
		return Resource{}, err
	}
	row.record.Status = StatusDisabled
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = time.Now().UTC()
	return cloneResource(row.record), nil
}

func (m *Memory) Enable(_ context.Context, scope isolation.Scope, kind, id string) (Resource, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, kind, id)
	if err != nil {
		return Resource{}, err
	}
	if len(row.versions) == 0 {
		row.record.Status = StatusDraft
	} else {
		row.record.Status = StatusPublished
	}
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = time.Now().UTC()
	return cloneResource(row.record), nil
}

func (m *Memory) Select(_ context.Context, scope isolation.Scope, kind, id string, in SelectInput) (Pin, error) {
	return m.selectLocked(scope, kind, id, in.VersionID, true)
}

func (m *Memory) Resolve(_ context.Context, scope isolation.Scope, refs []Ref) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	var out []Pin
	for _, ref := range refs {
		pin, err := m.selectLocked(scope, ref.Kind, ref.ResourceID, ref.VersionID, true)
		if err != nil {
			return nil, err
		}
		out = append(out, pin)
	}
	if out == nil {
		out = []Pin{}
	}
	return out, nil
}

func (m *Memory) BindPins(_ context.Context, scope isolation.Scope, in BindInput) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if in.OwnerKind != OwnerWorkflowVersion && in.OwnerKind != OwnerExecution {
		return nil, fmt.Errorf("%w: owner kind", ErrInvalid)
	}
	if !authz.ValidUUID(in.OwnerID) {
		return nil, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.pins {
		if existing.workspaceID == scope.WorkspaceID() && existing.ownerKind == in.OwnerKind && existing.ownerID == in.OwnerID {
			return nil, ErrImmutable
		}
	}
	for _, pin := range in.Pins {
		m.pins = append(m.pins, memoryPin{
			workspaceID: scope.WorkspaceID(),
			ownerKind:   in.OwnerKind,
			ownerID:     in.OwnerID,
			pin:         clonePin(pin),
		})
	}
	return m.listPinsLocked(scope, in.OwnerKind, in.OwnerID), nil
}

func (m *Memory) ListPins(_ context.Context, scope isolation.Scope, ownerKind, ownerID string) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listPinsLocked(scope, ownerKind, ownerID), nil
}

func (m *Memory) CopyPins(_ context.Context, scope isolation.Scope, fromKind, fromID, toKind, toID string) ([]Pin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	src := m.listPinsLocked(scope, fromKind, fromID)
	for _, existing := range m.pins {
		if existing.workspaceID == scope.WorkspaceID() && existing.ownerKind == toKind && existing.ownerID == toID {
			return m.listPinsLocked(scope, toKind, toID), nil
		}
	}
	for _, pin := range src {
		m.pins = append(m.pins, memoryPin{
			workspaceID: scope.WorkspaceID(),
			ownerKind:   toKind,
			ownerID:     toID,
			pin:         clonePin(pin),
		})
	}
	return m.listPinsLocked(scope, toKind, toID), nil
}

func (m *Memory) FindCredentialRefs(_ context.Context, scope isolation.Scope, credentialID string) ([]wfstore.CredentialRef, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(credentialID) {
		return []wfstore.CredentialRef{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []wfstore.CredentialRef
	for _, row := range m.resources {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		uses := row.record.CredentialID == credentialID || credentialIDFromSpec(row.draft.Spec) == credentialID
		for _, ver := range row.versions {
			if credentialIDFromSpec(ver.Spec) == credentialID {
				uses = true
				out = append(out, wfstore.CredentialRef{
					Kind:          wfstore.CredentialRefVersion,
					WorkflowID:    row.record.ID,
					WorkflowSlug:  row.record.Slug,
					WorkflowName:  row.record.Name,
					VersionID:     ver.ID,
					VersionNumber: ver.VersionNumber,
				})
			}
		}
		if !uses {
			continue
		}
		out = append(out, wfstore.CredentialRef{
			Kind:         wfstore.CredentialRefDraft,
			WorkflowID:   row.record.ID,
			WorkflowSlug: row.record.Slug,
			WorkflowName: row.record.Name,
		})
		for _, pin := range m.pins {
			if pin.workspaceID != scope.WorkspaceID() || pin.pin.ResourceID != row.record.ID || pin.ownerKind != OwnerExecution {
				continue
			}
			out = append(out, wfstore.CredentialRef{
				Kind:            wfstore.CredentialRefExecution,
				WorkflowID:      row.record.ID,
				WorkflowSlug:    row.record.Slug,
				WorkflowName:    row.record.Name,
				VersionID:       pin.pin.VersionID,
				VersionNumber:   pin.pin.VersionNumber,
				ExecutionID:     pin.ownerID,
				ExecutionStatus: wfstore.ExecutionPinned,
			})
		}
	}
	if out == nil {
		out = []wfstore.CredentialRef{}
	}
	return out, nil
}

func (m *Memory) selectLocked(scope isolation.Scope, kind, id, versionID string, lock bool) (Pin, error) {
	if scope.Zero() {
		return Pin{}, ErrNoScope
	}
	if !ValidKind(kind) || !authz.ValidUUID(id) {
		return Pin{}, ErrNotFound
	}
	if lock {
		m.mu.Lock()
		defer m.mu.Unlock()
	}
	row, err := m.lookupLocked(scope, kind, id)
	if err != nil {
		return Pin{}, err
	}
	if row.record.Status == StatusDisabled {
		return Pin{}, ErrDisabled
	}
	if row.record.Status == StatusDraft || len(row.versions) == 0 {
		return Pin{}, ErrDraftNotUsable
	}
	var ver Version
	if strings.TrimSpace(versionID) == "" {
		ver = row.versions[len(row.versions)-1]
	} else {
		if !authz.ValidUUID(versionID) {
			return Pin{}, ErrNotFound
		}
		found := false
		for _, candidate := range row.versions {
			if candidate.ID == versionID {
				ver = candidate
				found = true
				break
			}
		}
		if !found {
			return Pin{}, ErrNotFound
		}
	}
	return Pin{
		Kind:          kind,
		ResourceID:    row.record.ID,
		VersionID:     ver.ID,
		VersionNumber: ver.VersionNumber,
		Digest:        ver.Digest,
		Name:          row.record.Name,
		Slug:          row.record.Slug,
		Spec:          cloneMap(ver.Spec),
	}, nil
}

func (m *Memory) listPinsLocked(scope isolation.Scope, ownerKind, ownerID string) []Pin {
	var out []Pin
	for _, row := range m.pins {
		if row.workspaceID == scope.WorkspaceID() && row.ownerKind == ownerKind && row.ownerID == ownerID {
			out = append(out, clonePin(row.pin))
		}
	}
	if out == nil {
		out = []Pin{}
	}
	return out
}

func (m *Memory) lookup(scope isolation.Scope, kind, id string) (*memoryResource, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lookupLocked(scope, kind, id)
}

func (m *Memory) lookupLocked(scope isolation.Scope, kind, id string) (*memoryResource, error) {
	if !ValidKind(kind) || !authz.ValidUUID(id) {
		return nil, ErrNotFound
	}
	row, ok := m.resources[id]
	if !ok || row.workspaceID != scope.WorkspaceID() || row.record.Kind != kind {
		return nil, ErrNotFound
	}
	return row, nil
}

func cloneResource(in Resource) Resource { return in }

func cloneDraft(in Draft) Draft {
	in.Spec = cloneMap(in.Spec)
	return in
}

func cloneVersion(in Version) Version {
	in.Spec = cloneMap(in.Spec)
	return in
}

func clonePin(in Pin) Pin {
	in.Spec = cloneMap(in.Spec)
	return in
}

func cloneMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
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
