package approval

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// TestDecideRacesLeaseRecovery fails by timeout if recovery still holds the
// workflow lock while it calls HasPending. Decide takes the approval lock
// and then the workflow lock.
func TestDecideRacesLeaseRecovery(t *testing.T) {
	ctx := context.Background()
	workflows := wfstore.NewMemory()
	approvals := NewMemory()
	ownerID := "22222222-2222-4222-8222-222222222222"
	otherID := "55555555-5555-4555-8555-555555555555"
	workspaceID := "11111111-1111-4111-8111-111111111111"
	owner, err := isolation.Authorize(workspaceID, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	other, err := isolation.Authorize(workspaceID, otherID)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	workflows.SetApprovalPending(func(executionID, nodeID string) bool {
		once.Do(func() { close(entered) })
		<-release
		return approvals.HasPending(executionID, nodeID)
	})
	approvals.SetGateWaiting(workflows.ApprovalGateWaiting)

	ver := publishMemoryWorkflow(t, ctx, workflows, owner, `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: recovery-race
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
        expiresIn: PT1H
  edges: []
`)
	exec, err := workflows.StartExecution(ctx, owner, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	claimed, err := workflows.ClaimJob(ctx, owner, now, wfstore.ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	rec, err := approvals.Create(ctx, owner, CreateInput{
		WorkflowID: exec.WorkflowID, WorkflowVersionID: exec.WorkflowVersionID, WorkflowDigest: exec.WorkflowDigest,
		ExecutionID: exec.ID, RequestedBy: ownerID,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := workflows.RecoverExpiredLeases(ctx, owner, now.Add(2*time.Minute))
		errCh <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("recovery did not reach the approval check")
	}
	decideDone := make(chan struct{})
	go func() {
		defer close(decideDone)
		_, _ = approvals.Decide(ctx, other, rec.ID, DecideInput{
			Decision: DecisionApproved,
			Now:      now,
			Roles:    []string{"approver"},
		})
	}()
	time.Sleep(100 * time.Millisecond)
	close(release)
	select {
	case <-decideDone:
	case <-time.After(5 * time.Second):
		t.Fatal("decide and recovery deadlocked")
	}
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("recovery did not finish")
	}
}
