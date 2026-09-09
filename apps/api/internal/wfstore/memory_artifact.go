package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func (m *Memory) CreateArtifact(_ context.Context, scope isolation.Scope, in CreateArtifactInput) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(in.ExecutionID) {
		return Artifact{}, ErrNotFound
	}
	if in.StepID != "" && !authz.ValidUUID(in.StepID) {
		return Artifact{}, ErrInvalid
	}
	if strings.TrimSpace(in.StorageRef) == "" || strings.TrimSpace(in.Digest) == "" {
		return Artifact{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[in.ExecutionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return Artifact{}, ErrNotFound
	}
	if in.StepID != "" {
		found := false
		for _, step := range exec.steps {
			if step.ID == in.StepID {
				found = true
				break
			}
		}
		if !found {
			return Artifact{}, ErrNotFound
		}
	}
	now := time.Now().UTC()
	expires := in.ExpiresAt
	if expires.IsZero() {
		expires = exec.record.RetentionUntil
	}
	if expires.IsZero() {
		expires = now.Add(DefaultExecutionRetention)
	}
	art := Artifact{
		ID:                    newID(),
		ExecutionID:           in.ExecutionID,
		ExecutionStepID:       strings.TrimSpace(in.StepID),
		Kind:                  strings.TrimSpace(in.Kind),
		Filename:              strings.TrimSpace(in.Filename),
		ContentType:           strings.TrimSpace(in.ContentType),
		Digest:                in.Digest,
		SizeBytes:             in.SizeBytes,
		ContentClassification: in.ContentClassification,
		Redacted:              in.Redacted,
		ExpiresAt:             expires,
		CreatedAt:             now,
		UpdatedAt:             now,
		StorageRef:            in.StorageRef,
		DEKEnvelope:           append([]byte(nil), in.DEKEnvelope...),
		KeyReference:          in.KeyReference,
		EncryptionVersion:     in.EncryptionVersion,
		MetadataCiphertext:    append([]byte(nil), in.MetadataCiphertext...),
	}
	m.artifacts[art.ID] = memArtifact{workspaceID: scope.WorkspaceID(), record: cloneArtifact(art)}
	return cloneArtifact(art), nil
}

func (m *Memory) GetArtifact(_ context.Context, scope isolation.Scope, artifactID string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(artifactID) {
		return Artifact{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.artifacts[artifactID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Artifact{}, ErrNotFound
	}
	return cloneArtifact(row.record), nil
}

func (m *Memory) ListArtifacts(_ context.Context, scope isolation.Scope, filter ArtifactListFilter) ([]Artifact, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if filter.ExecutionID != "" && !authz.ValidUUID(filter.ExecutionID) {
		return nil, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if filter.ExecutionID != "" {
		exec, ok := m.executions[filter.ExecutionID]
		if !ok || exec.workspaceID != scope.WorkspaceID() {
			return nil, ErrNotFound
		}
	}
	var out []Artifact
	for _, row := range m.artifacts {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if filter.ExecutionID != "" && row.record.ExecutionID != filter.ExecutionID {
			continue
		}
		if filter.StepID != "" && row.record.ExecutionStepID != filter.StepID {
			continue
		}
		if filter.Kind != "" && row.record.Kind != filter.Kind {
			continue
		}
		out = append(out, cloneArtifact(row.record))
	}
	if out == nil {
		out = []Artifact{}
	}
	return out, nil
}

func (m *Memory) DeleteArtifact(_ context.Context, scope isolation.Scope, artifactID string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.artifacts[artifactID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return ErrNotFound
	}
	if row.record.LegalHold {
		return ErrLegalHold
	}
	delete(m.artifacts, artifactID)
	for id, g := range m.grants {
		if g.record.ArtifactID == artifactID {
			delete(m.grants, id)
		}
	}
	return nil
}

func (m *Memory) SetLegalHold(_ context.Context, scope isolation.Scope, artifactID string, in LegalHoldInput) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.artifacts[artifactID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Artifact{}, ErrNotFound
	}
	now := time.Now().UTC()
	art := row.record
	art.LegalHold = in.Hold
	art.UpdatedAt = now
	if in.Hold {
		art.LegalHoldReason = strings.TrimSpace(in.Reason)
		art.LegalHoldBy = scope.ActorID()
		t := now
		art.LegalHoldAt = &t
	} else {
		art.LegalHoldReason = ""
		art.LegalHoldBy = ""
		art.LegalHoldAt = nil
	}
	row.record = cloneArtifact(art)
	m.artifacts[artifactID] = row
	return cloneArtifact(art), nil
}

func (m *Memory) CreateDownloadGrant(_ context.Context, scope isolation.Scope, artifactID string, now time.Time, ttl time.Duration) (DownloadGrant, error) {
	if scope.Zero() {
		return DownloadGrant{}, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if ttl <= 0 {
		ttl = DefaultDownloadTTL
	}
	if ttl > MaxDownloadTTL {
		ttl = MaxDownloadTTL
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.artifacts[artifactID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return DownloadGrant{}, ErrNotFound
	}
	if !row.record.ExpiresAt.After(now) && !row.record.LegalHold {
		return DownloadGrant{}, ErrArtifactExpired
	}
	grant := DownloadGrant{
		ID:         newID(),
		ArtifactID: artifactID,
		ExpiresAt:  now.Add(ttl),
		Method:     "GET",
		ActorID:    scope.ActorID(),
	}
	grant.Href = "/api/v1/artifact-downloads/" + grant.ID
	m.grants[grant.ID] = memGrant{workspaceID: scope.WorkspaceID(), record: grant}
	return grant, nil
}

func (m *Memory) GetDownloadGrant(_ context.Context, scope isolation.Scope, grantID string, now time.Time) (DownloadGrant, Artifact, error) {
	if scope.Zero() {
		return DownloadGrant{}, Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(grantID) {
		return DownloadGrant{}, Artifact{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.grants[grantID]
	if !ok || g.workspaceID != scope.WorkspaceID() {
		return DownloadGrant{}, Artifact{}, ErrNotFound
	}
	if !g.record.ExpiresAt.After(now) {
		return DownloadGrant{}, Artifact{}, ErrGrantExpired
	}
	row, ok := m.artifacts[g.record.ArtifactID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return DownloadGrant{}, Artifact{}, ErrNotFound
	}
	if !row.record.ExpiresAt.After(now) && !row.record.LegalHold {
		return DownloadGrant{}, Artifact{}, ErrArtifactExpired
	}
	return g.record, cloneArtifact(row.record), nil
}

func (m *Memory) PlanRetentionPurge(_ context.Context, scope isolation.Scope, now time.Time) (RetentionPlan, error) {
	if scope.Zero() {
		return RetentionPlan{}, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var plan RetentionPlan
	for _, row := range m.artifacts {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if row.record.ExpiresAt.After(now) {
			continue
		}
		if row.record.LegalHold {
			plan.Hold = append(plan.Hold, cloneArtifact(row.record))
			continue
		}
		plan.Purge = append(plan.Purge, cloneArtifact(row.record))
	}
	if plan.Purge == nil {
		plan.Purge = []Artifact{}
	}
	if plan.Hold == nil {
		plan.Hold = []Artifact{}
	}
	return plan, nil
}

func (m *Memory) executionHasLegalHoldLocked(executionID string) bool {
	for _, row := range m.artifacts {
		if row.record.ExecutionID == executionID && row.record.LegalHold {
			return true
		}
	}
	return false
}

func cloneArtifact(a Artifact) Artifact {
	out := a
	out.DEKEnvelope = append([]byte(nil), a.DEKEnvelope...)
	out.MetadataCiphertext = append([]byte(nil), a.MetadataCiphertext...)
	if a.LegalHoldAt != nil {
		t := *a.LegalHoldAt
		out.LegalHoldAt = &t
	}
	return out
}
