package approval

import (
	"context"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestMemoryResyncKeepsStepRoleOnPinnedPolicy(t *testing.T) {
	ctx := context.Background()
	approvals := NewMemory()
	ops := opsconfig.NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC)
	v1Spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "admin", "expiresIn": "PT1H"}}
	resource, draft, err := ops.Create(ctx, scope, opsconfig.CreateInput{
		Kind: opsconfig.KindPolicy, Name: "Pinned role", Slug: "pinned-role", Spec: v1Spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver1, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	versionID := "55555555-5555-4555-8555-555555555555"
	digest := "sha256:" + repeatHash("ab")
	execID := "66666666-6666-4666-8666-666666666666"
	// A published flow.approval must declare approverRole. The step value
	// wins; the pinned policy fills a blank field only on the node rebuild
	// (policy.requirementFromNode). A later policy revision is not consulted.
	yaml := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: pinned-role
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        policyId: ` + resource.ID + `
        expiresIn: PT1H
  edges: []
`
	RememberRun(approvals, execID, versionID, digest, []opsconfig.Pin{{
		Kind: opsconfig.KindPolicy, ResourceID: resource.ID, VersionID: ver1.ID,
		VersionNumber: ver1.VersionNumber, Digest: ver1.Digest, Spec: v1Spec,
	}})
	rec, err := approvals.Create(ctx, scope, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: versionID, WorkflowDigest: digest,
		ExecutionID: execID,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	v2Spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "auditor", "expiresIn": "PT2H"}}
	_, next, err := ops.SaveDraft(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.SaveInput{
		ExpectedRevision: draft.Revision, Spec: v2Spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver2, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.PublishInput{ExpectedRevision: next.Revision, Note: "v2"})
	if err != nil {
		t.Fatal(err)
	}
	stats := approvals.ResyncPending(ctx, staticVersion{ver: wfstore.Version{ID: versionID, DefinitionYAML: yaml, Digest: digest}}, ops, now)
	if stats.Closed != 0 || stats.Corrected != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusPending || got.ApproverRole != "approver" || got.PolicyVersionID != ver1.ID || got.PolicyVersionID == ver2.ID {
		t.Fatalf("row = %+v %v newer %s", got, err, ver2.ID)
	}
}

func TestMemoryResyncKeepsStepRoleOverPolicy(t *testing.T) {
	ctx := context.Background()
	approvals := NewMemory()
	ops := opsconfig.NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC)
	v1Spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "approver", "expiresIn": "PT1H"}}
	resource, draft, err := ops.Create(ctx, scope, opsconfig.CreateInput{
		Kind: opsconfig.KindPolicy, Name: "Step role", Slug: "step-role", Spec: v1Spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver1, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	versionID := "55555555-5555-4555-8555-555555555555"
	digest := "sha256:" + repeatHash("cd")
	execID := "77777777-7777-4777-8777-777777777777"
	yaml := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: step-role
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
        policyId: ` + resource.ID + `
        expiresIn: PT1H
  edges: []
`
	RememberRun(approvals, execID, versionID, digest, []opsconfig.Pin{{
		Kind: opsconfig.KindPolicy, ResourceID: resource.ID, VersionID: ver1.ID,
		VersionNumber: ver1.VersionNumber, Digest: ver1.Digest,
	}})
	rec, err := approvals.Create(ctx, scope, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: versionID, WorkflowDigest: digest,
		ExecutionID: execID,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	stats := approvals.ResyncPending(ctx, staticVersion{ver: wfstore.Version{ID: versionID, DefinitionYAML: yaml, Digest: digest}}, ops, now)
	if stats.Closed != 0 || stats.Corrected != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusPending || got.ApproverRole != "admin" || got.PolicyVersionID != ver1.ID {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func repeatHash(pair string) string {
	out := ""
	for len(out) < 64 {
		out += pair
	}
	return out[:64]
}
