package wfstore

import (
	"context"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestMemoryArtifactHoldAndPurgePlan(t *testing.T) {
	m := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	normalized := mustNormalize(t, fixtureYAML)
	wf, draft, err := m.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := m.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := m.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	steps, err := m.ListSteps(ctx, scope, exec.ID)
	if err != nil || len(steps) == 0 {
		t.Fatalf("steps: %v", err)
	}
	now := time.Now().UTC()
	art, err := m.CreateArtifact(ctx, scope, CreateArtifactInput{
		ExecutionID:           exec.ID,
		StepID:                steps[0].ID,
		Kind:                  "file",
		Filename:              "note.txt",
		ContentType:           "text/plain",
		ContentClassification: "internal",
		Digest:                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		SizeBytes:             4,
		Redacted:              true,
		ExpiresAt:             now.Add(-time.Hour),
		StorageRef:            "33333333-3333-3333-3333-333333333333",
		MetadataCiphertext:    []byte("meta"),
		DEKEnvelope:           []byte("dek"),
		KeyReference:          "test",
		EncryptionVersion:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetLegalHold(ctx, scope, art.ID, LegalHoldInput{Hold: true, Reason: "case"}); err != nil {
		t.Fatal(err)
	}
	plan, err := m.PlanRetentionPurge(ctx, scope, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Hold) != 1 || len(plan.Purge) != 0 {
		t.Fatalf("plan = %+v", plan)
	}
	if err := m.DeleteArtifact(ctx, scope, art.ID); err != ErrLegalHold {
		t.Fatalf("delete held: %v", err)
	}
	if _, err := m.SetLegalHold(ctx, scope, art.ID, LegalHoldInput{Hold: false}); err != nil {
		t.Fatal(err)
	}
	plan, err = m.PlanRetentionPurge(ctx, scope, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Purge) != 1 {
		t.Fatalf("purge plan = %+v", plan)
	}
	if err := m.DeleteArtifact(ctx, scope, art.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.GetArtifact(ctx, scope, art.ID); err != ErrNotFound {
		t.Fatalf("get after delete: %v", err)
	}
}

func TestMemoryCreateArtifactRejectsDraftExecution(t *testing.T) {
	m := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	execID := "55555555-5555-4555-8555-555555555555"
	m.executions[execID] = memExecution{
		workspaceID: scope.WorkspaceID(),
		record:      Execution{ID: execID},
	}
	_, err = m.CreateArtifact(context.Background(), scope, CreateArtifactInput{
		ExecutionID:        execID,
		Kind:               "file",
		Digest:             "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		StorageRef:         "66666666-6666-4666-8666-666666666666",
		MetadataCiphertext: []byte("meta"),
		DEKEnvelope:        []byte("dek"),
		KeyReference:       "test",
		EncryptionVersion:  1,
	})
	if err != ErrDraftNotRunnable {
		t.Fatalf("draft artifact = %v", err)
	}
	if len(m.artifacts) != 0 {
		t.Fatal("draft execution stored an artifact row")
	}
}

func TestMemoryDownloadGrantExpiry(t *testing.T) {
	m := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	normalized := mustNormalize(t, fixtureYAML)
	wf, draft, err := m.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := m.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := m.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	art, err := m.CreateArtifact(ctx, scope, CreateArtifactInput{
		ExecutionID:           exec.ID,
		Kind:                  "output",
		Filename:              "out.json",
		ContentType:           "application/json",
		ContentClassification: "internal",
		Digest:                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		SizeBytes:             2,
		Redacted:              true,
		StorageRef:            "44444444-4444-4444-4444-444444444444",
		MetadataCiphertext:    []byte("meta"),
		DEKEnvelope:           []byte("dek"),
		KeyReference:          "test",
		EncryptionVersion:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	grant, err := m.CreateDownloadGrant(ctx, scope, art.ID, now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.GetDownloadGrant(ctx, scope, grant.ID, now.Add(2*time.Second)); err != ErrGrantExpired {
		t.Fatalf("expired grant: %v", err)
	}
	if _, _, err := m.GetDownloadGrant(ctx, scope, grant.ID, now); err != nil {
		t.Fatal(err)
	}
}
