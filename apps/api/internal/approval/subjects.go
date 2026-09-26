package approval

import (
	"context"
	"fmt"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// SubjectDirectory distinguishes a missing approver record from a record
// whose membership is currently empty. A user row or a group row that
// still exists can be rebuilt. A missing row cannot.
type SubjectDirectory interface {
	UserRecordExists(ctx context.Context, userID string) (bool, error)
	UserIsWorkspaceMember(ctx context.Context, workspaceID, userID string) (bool, error)
	GroupRecordExists(ctx context.Context, workspaceID, groupID string) (bool, error)
	UserInGroup(ctx context.Context, workspaceID, groupID, userID string) (bool, error)
}

type postgresSubjects struct {
	db DB
}

// NewSubjectDirectory reads users, workspace membership, and approver groups.
func NewSubjectDirectory(db DB) SubjectDirectory {
	if db == nil {
		return nil
	}
	return postgresSubjects{db: db}
}

func (p postgresSubjects) UserRecordExists(ctx context.Context, userID string) (bool, error) {
	userID = strings.TrimSpace(userID)
	if !authz.ValidUUID(userID) {
		return false, nil
	}
	var exists bool
	err := p.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1::uuid)`, userID).Scan(&exists)
	if err != nil {
		return false, mapDBErr(err)
	}
	return exists, nil
}

func (p postgresSubjects) UserIsWorkspaceMember(ctx context.Context, workspaceID, userID string) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	userID = strings.TrimSpace(userID)
	if !authz.ValidUUID(workspaceID) || !authz.ValidUUID(userID) {
		return false, nil
	}
	var exists bool
	err := p.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM workspace_role_bindings
			 WHERE workspace_id = $1::uuid AND user_id = $2::uuid
		)`, workspaceID, userID).Scan(&exists)
	if err != nil {
		return false, mapDBErr(err)
	}
	return exists, nil
}

func (p postgresSubjects) GroupRecordExists(ctx context.Context, workspaceID, groupID string) (bool, error) {
	return p.scopedExists(ctx, workspaceID, `
		SELECT EXISTS(
			SELECT 1 FROM approver_groups
			 WHERE workspace_id = $1::uuid AND id = $2::uuid
		)`, groupID)
}

func (p postgresSubjects) UserInGroup(ctx context.Context, workspaceID, groupID, userID string) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	groupID = strings.TrimSpace(groupID)
	userID = strings.TrimSpace(userID)
	if !authz.ValidUUID(workspaceID) || !authz.ValidUUID(groupID) || !authz.ValidUUID(userID) {
		return false, nil
	}
	tx, err := postgres.BeginScoped(ctx, p.db, workspaceID)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM approver_group_members
			 WHERE workspace_id = $1::uuid AND group_id = $2::uuid AND user_id = $3::uuid
		)`, workspaceID, groupID, userID).Scan(&exists)
	if err != nil {
		return false, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, mapDBErr(err)
	}
	return exists, nil
}

func (p postgresSubjects) scopedExists(ctx context.Context, workspaceID, query, id string) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	id = strings.TrimSpace(id)
	if !authz.ValidUUID(workspaceID) || !authz.ValidUUID(id) {
		return false, nil
	}
	tx, err := postgres.BeginScoped(ctx, p.db, workspaceID)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, query, workspaceID, id).Scan(&exists); err != nil {
		return false, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, mapDBErr(err)
	}
	return exists, nil
}

// confirmSubjectRecords fails closed when a named user or group row is gone.
// An empty membership is not a missing record and returns nil.
func confirmSubjectRecords(ctx context.Context, scope isolation.Scope, subjects SubjectDirectory, req policy.Requirement) error {
	if subjects == nil {
		return nil
	}
	if id := strings.TrimSpace(req.ApproverUserID); id != "" {
		ok, err := subjects.UserRecordExists(ctx, id)
		if err != nil || !ok {
			return fmt.Errorf("%w: approver user record is missing", ErrBindingUnresolved)
		}
	}
	if id := strings.TrimSpace(req.ApproverGroupID); id != "" {
		ok, err := subjects.GroupRecordExists(ctx, scope.WorkspaceID(), id)
		if err != nil || !ok {
			return fmt.Errorf("%w: approver group record is missing", ErrBindingUnresolved)
		}
	}
	return nil
}
