package approval

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestSubjectRecordsVersusEmptyMembership(t *testing.T) {
	ctx := context.Background()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	userID := "33333333-3333-4333-8333-333333333333"
	groupID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10"
	ver := wfstore.Version{
		ID: "88888888-8888-4888-8888-888888888888", WorkflowID: "44444444-4444-4444-8444-444444444444",
		DefinitionYAML: groupRequirementYAML(groupID), Digest: "sha256:" + "abababababababababababababababababababababababababababababababab",
	}
	now := time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC)
	empty := staticSubjects{groups: map[string]bool{scope.WorkspaceID() + "|" + groupID: true}}
	req, err := ResolveGateRequirement(ctx, scope, staticVersion{ver: ver}, nil, empty, ver.WorkflowID, ver.ID, "gate", now)
	if err != nil || req.ApproverGroupID != groupID {
		t.Fatalf("empty group = %+v %v", req, err)
	}
	rec := Record{ApproverRole: "approver", ApproverGroupID: groupID, NodeID: "gate", WorkflowVersionID: ver.ID, WorkflowDigest: ver.Digest}
	ok, err := targetAllows(ctx, scope, DecideInput{Roles: []string{"approver"}, GroupIDs: []string{groupID}, Subjects: empty}, rec)
	if err != nil || ok {
		t.Fatalf("empty group decide = %v %v", ok, err)
	}
	gone := staticSubjects{}
	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{ver: ver}, nil, gone, ver.WorkflowID, ver.ID, "gate", now); !errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("deleted group = %v", err)
	}
	userVer := ver
	userVer.DefinitionYAML = userRequirementYAML(userID)
	removed := staticSubjects{users: map[string]bool{userID: true}}
	userReq, err := ResolveGateRequirement(ctx, scope, staticVersion{ver: userVer}, nil, removed, ver.WorkflowID, ver.ID, "gate", now)
	if err != nil || userReq.ApproverUserID != userID {
		t.Fatalf("removed user = %+v %v", userReq, err)
	}
	actor, err := isolation.Authorize(scope.WorkspaceID(), userID)
	if err != nil {
		t.Fatal(err)
	}
	userRec := Record{ApproverRole: "approver", ApproverUserID: userID}
	ok, err = targetAllows(ctx, actor, DecideInput{Roles: []string{"approver"}, Subjects: removed}, userRec)
	if err != nil || ok {
		t.Fatalf("removed user decide = %v %v", ok, err)
	}
	member := staticSubjects{users: map[string]bool{userID: true}, members: map[string]bool{scope.WorkspaceID() + "|" + userID: true}}
	ok, err = targetAllows(ctx, actor, DecideInput{Roles: []string{"approver"}, Subjects: member}, userRec)
	if err != nil || !ok {
		t.Fatalf("re-added user decide = %v %v", ok, err)
	}
}

type staticSubjects struct {
	users   map[string]bool
	members map[string]bool
	groups  map[string]bool
	inGroup map[string]bool
}

func (s staticSubjects) UserRecordExists(_ context.Context, userID string) (bool, error) {
	return s.users[userID], nil
}
func (s staticSubjects) UserIsWorkspaceMember(_ context.Context, workspaceID, userID string) (bool, error) {
	return s.members[workspaceID+"|"+userID], nil
}
func (s staticSubjects) GroupRecordExists(_ context.Context, workspaceID, groupID string) (bool, error) {
	return s.groups[workspaceID+"|"+groupID], nil
}
func (s staticSubjects) UserInGroup(_ context.Context, workspaceID, groupID, userID string) (bool, error) {
	return s.inGroup[workspaceID+"|"+groupID+"|"+userID], nil
}

func groupRequirementYAML(groupID string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: group-requirement
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
        approverGroupId: ` + groupID + `
        expiresIn: PT1H
  edges: []
`
}

func userRequirementYAML(userID string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: user-requirement
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
        approverUserId: ` + userID + `
        expiresIn: PT1H
  edges: []
`
}
