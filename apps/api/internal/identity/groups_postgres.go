package identity

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// groupNameIndex is the case-insensitive unique index from migration 000043.
const groupNameIndex = "workspace_groups_name_uidx"

var _ GroupStore = (*Postgres)(nil)

// beginGroupTx opens a transaction scoped to workspaceID so FORCE RLS on
// the group tables applies. A malformed workspace id never opens a scope.
func (p *Postgres) beginGroupTx(ctx context.Context, workspaceID string) (pgx.Tx, error) {
	if !authz.ValidUUID(workspaceID) {
		return nil, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, workspaceID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	return tx, nil
}

func (p *Postgres) ListGroupsPage(ctx context.Context, workspaceID string, q page.Query) ([]Group, string, error) {
	if q.Bound && (q.Limit < 1 || q.Limit > page.MaxLimit) {
		return nil, "", page.ErrInvalid
	}
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)

	args := []any{workspaceID}
	sql := `
		SELECT g.id::text, g.display_name, lower(g.display_name),
		       (SELECT count(*) FROM workspace_group_members m
		         WHERE m.workspace_id = g.workspace_id AND m.group_id = g.id)::int,
		       g.created_at, g.updated_at
		FROM workspace_groups g
		WHERE g.workspace_id = $1::uuid`
	if pred := page.SearchPredicate(&args, q.Q, "g.display_name"); pred != "" {
		sql += " AND " + pred
	}
	order := ` ORDER BY lower(g.display_name), g.id`
	if q.Bound {
		keyset, err := page.AscTextPredicate(&args, page.ColGroup, "lower(g.display_name)", "g.id", q.Cursor)
		if err != nil {
			return nil, "", err
		}
		if keyset != "" {
			sql += " AND " + keyset
		}
		order += page.LimitSQL(&args, q)
	}
	rows, err := tx.Query(ctx, sql+order, args...)
	if err != nil {
		return nil, "", mapDBErr(err)
	}
	type row struct {
		g   Group
		key string
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.g.ID, &r.g.DisplayName, &r.key, &r.g.MemberCount, &r.g.CreatedAt, &r.g.UpdatedAt); err != nil {
			rows.Close()
			return nil, "", mapDBErr(err)
		}
		got = append(got, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, "", mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", mapDBErr(err)
	}
	next := ""
	if q.Bound {
		got, next, err = page.Trim(page.ColGroup, q, got, func(r row) page.Key {
			return page.Key{K: r.key, ID: r.g.ID}
		})
		if err != nil {
			return nil, "", err
		}
	}
	out := make([]Group, 0, len(got))
	for _, r := range got {
		out = append(out, r.g)
	}
	return out, next, nil
}

func (p *Postgres) CreateGroup(ctx context.Context, workspaceID string, actor GroupActor, displayName string) (Group, error) {
	name, err := NormalizeGroupName(displayName)
	if err != nil {
		return Group{}, err
	}
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return Group{}, err
	}
	defer tx.Rollback(ctx)

	// No pre-check: the unique index is the only arbiter, so a create
	// that loses a concurrent race gets the same 409 as a plain clash.
	var g Group
	err = tx.QueryRow(ctx, `
		INSERT INTO workspace_groups (workspace_id, display_name, created_by, updated_by)
		VALUES ($1::uuid, $2, NULLIF($3, '')::uuid, NULLIF($3, '')::uuid)
		RETURNING id::text, display_name, created_at, updated_at
	`, workspaceID, name, actorUUID(actor)).Scan(&g.ID, &g.DisplayName, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return Group{}, mapGroupErr(err)
	}
	if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupCreate, g.ID, "created", nil); err != nil {
		return Group{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Group{}, mapGroupErr(err)
	}
	return g, nil
}

func (p *Postgres) GetGroup(ctx context.Context, workspaceID, groupID string) (GroupDetail, error) {
	if !authz.ValidUUID(groupID) {
		return GroupDetail{}, ErrNotFound
	}
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return GroupDetail{}, err
	}
	defer tx.Rollback(ctx)

	var d GroupDetail
	err = tx.QueryRow(ctx, `
		SELECT id::text, display_name, created_at, updated_at
		FROM workspace_groups
		WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, workspaceID, groupID).Scan(&d.ID, &d.DisplayName, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return GroupDetail{}, mapDBErr(err)
	}
	// Every member row is listed. A disabled user who still has rows
	// stays visible with canApprove false so an admin can clean it up.
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.display_name, u.status,
		       ARRAY(SELECT r.key FROM workspace_role_bindings b
		             JOIN roles r ON r.id = b.role_id
		             WHERE b.workspace_id = m.workspace_id AND b.user_id = u.id
		             ORDER BY r.key)
		FROM workspace_group_members m
		JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = $1::uuid AND m.group_id = $2::uuid
		ORDER BY lower(u.display_name), u.id
	`, workspaceID, groupID)
	if err != nil {
		return GroupDetail{}, mapDBErr(err)
	}
	d.Members = []GroupMember{}
	for rows.Next() {
		var m GroupMember
		var status string
		var roles []string
		if err := rows.Scan(&m.UserID, &m.DisplayName, &status, &roles); err != nil {
			rows.Close()
			return GroupDetail{}, mapDBErr(err)
		}
		m.CanApprove = memberCanApprove(status, roles)
		d.Members = append(d.Members, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return GroupDetail{}, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return GroupDetail{}, mapDBErr(err)
	}
	d.MemberCount = len(d.Members)
	return d, nil
}

func (p *Postgres) RenameGroup(ctx context.Context, workspaceID string, actor GroupActor, groupID, displayName string) (Group, error) {
	name, err := NormalizeGroupName(displayName)
	if err != nil {
		return Group{}, err
	}
	if !authz.ValidUUID(groupID) {
		return Group{}, ErrNotFound
	}
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return Group{}, err
	}
	defer tx.Rollback(ctx)

	var g Group
	err = tx.QueryRow(ctx, `
		UPDATE workspace_groups
		   SET display_name = $3, updated_by = NULLIF($4, '')::uuid, updated_at = now()
		 WHERE workspace_id = $1::uuid AND id = $2::uuid
		RETURNING id::text, display_name, created_at, updated_at,
		          (SELECT count(*) FROM workspace_group_members m
		            WHERE m.workspace_id = $1::uuid AND m.group_id = $2::uuid)::int
	`, workspaceID, groupID, name, actorUUID(actor)).Scan(&g.ID, &g.DisplayName, &g.CreatedAt, &g.UpdatedAt, &g.MemberCount)
	if err != nil {
		return Group{}, mapGroupErr(err)
	}
	if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupRename, g.ID, "updated", nil); err != nil {
		return Group{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Group{}, mapGroupErr(err)
	}
	return g, nil
}

func (p *Postgres) DeleteGroup(ctx context.Context, workspaceID string, actor GroupActor, groupID string) error {
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Member rows go with the group (ON DELETE CASCADE).
	tag, err := tx.Exec(ctx, `
		DELETE FROM workspace_groups WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, workspaceID, groupID)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupDelete, groupID, "deleted", nil); err != nil {
		return err
	}
	return mapDBErr(tx.Commit(ctx))
}

func (p *Postgres) AddGroupMember(ctx context.Context, workspaceID string, actor GroupActor, groupID, userID string) error {
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := requireGroupTx(ctx, tx, workspaceID, groupID); err != nil {
		return err
	}
	if !authz.ValidUUID(userID) {
		return ErrGroupMemberNotInWorkspace
	}
	// FOR SHARE on the binding rows: a concurrent RemoveMember deletes
	// bindings first, so it waits for this add to commit and then its
	// group-row delete sees (and removes) the new row. No orphan row for
	// a removed user can survive.
	var bound bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS (
		    SELECT 1
		    FROM workspace_role_bindings b
		    JOIN users u ON u.id = b.user_id
		    WHERE b.workspace_id = $1::uuid AND b.user_id = $2::uuid AND u.status = 'active'
		    FOR SHARE OF b
		)
	`, workspaceID, userID).Scan(&bound)
	if err != nil {
		return mapDBErr(err)
	}
	if !bound {
		return ErrGroupMemberNotInWorkspace
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO workspace_group_members (workspace_id, group_id, user_id, added_by)
		VALUES ($1::uuid, $2::uuid, $3::uuid, NULLIF($4, '')::uuid)
		ON CONFLICT (workspace_id, group_id, user_id) DO NOTHING
	`, workspaceID, groupID, userID, actorUUID(actor))
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 1 {
		if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupMemberAdd, groupID, "added", map[string]string{"userId": userID}); err != nil {
			return err
		}
	}
	return mapDBErr(tx.Commit(ctx))
}

func (p *Postgres) RemoveGroupMember(ctx context.Context, workspaceID string, actor GroupActor, groupID, userID string) error {
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := requireGroupTx(ctx, tx, workspaceID, groupID); err != nil {
		return err
	}
	if !authz.ValidUUID(userID) {
		// Cannot be a member. Idempotent no-op.
		return mapDBErr(tx.Commit(ctx))
	}
	tag, err := tx.Exec(ctx, `
		DELETE FROM workspace_group_members
		 WHERE workspace_id = $1::uuid AND group_id = $2::uuid AND user_id = $3::uuid
	`, workspaceID, groupID, userID)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() > 0 {
		if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupMemberRemove, groupID, "removed", map[string]string{"userId": userID}); err != nil {
			return err
		}
	}
	return mapDBErr(tx.Commit(ctx))
}

func requireGroupTx(ctx context.Context, tx pgx.Tx, workspaceID, groupID string) error {
	var one int
	err := tx.QueryRow(ctx, `
		SELECT 1 FROM workspace_groups WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, workspaceID, groupID).Scan(&one)
	return mapDBErr(err)
}

// insertGroupAudit writes one audit_events row in the caller's scoped
// transaction. Details are ids only: groupId plus userId for member rows.
func insertGroupAudit(ctx context.Context, tx pgx.Tx, workspaceID string, actor GroupActor, action, groupID, outcome string, extra map[string]string) error {
	details := map[string]string{"groupId": groupID}
	for k, v := range extra {
		details[k] = v
	}
	detailsRaw, err := json.Marshal(details)
	if err != nil {
		return err
	}
	host := map[string]string{}
	rid := auditCorrelation(actor.RequestID)
	if rid != "" {
		host["requestId"] = rid
	}
	hostRaw, err := json.Marshal(host)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events (
			workspace_id, actor_id, host_context_redacted, action, resource_type,
			resource_id, outcome, correlation_id, details_redacted
		) VALUES (
			$1::uuid, NULLIF($2, '')::uuid, $3::jsonb, $4, $5,
			$6::uuid, $7, NULLIF($8, ''), $9::jsonb
		)
	`, workspaceID, actorUUID(actor), hostRaw, action, AuditGroupResource, groupID, outcome, rid, detailsRaw)
	return mapDBErr(err)
}

func actorUUID(actor GroupActor) string {
	id := strings.TrimSpace(actor.UserID)
	if !authz.ValidUUID(id) {
		return ""
	}
	return id
}

// auditCorrelation keeps a request id that fits audit_events.correlation_id.
func auditCorrelation(id string) string {
	id = strings.TrimSpace(id)
	if len(id) > 128 {
		return ""
	}
	return id
}

// mapGroupErr maps the display-name unique index to ErrGroupNameTaken.
// Every other error keeps the identity mapping.
func mapGroupErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == groupNameIndex {
		return ErrGroupNameTaken
	}
	return mapDBErr(err)
}
