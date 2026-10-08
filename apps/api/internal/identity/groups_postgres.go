package identity

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approvalgate"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// groupNameIndex is the case-insensitive unique index from migration 000043.
const groupNameIndex = "workspace_groups_name_uidx"

// groupExternalIDIndex is the partial unique index from migration 000046.
const groupExternalIDIndex = "workspace_groups_external_id_uidx"

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
		       g.created_at, g.updated_at, g.managed_by
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
		if err := rows.Scan(&r.g.ID, &r.g.DisplayName, &r.key, &r.g.MemberCount, &r.g.CreatedAt, &r.g.UpdatedAt, &r.g.ManagedBy); err != nil {
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
	var g Group
	err := p.groupTx(ctx, workspaceID, func(tx pgx.Tx) error {
		var err error
		g, err = CreateGroupTx(ctx, tx, workspaceID, actor, displayName, "")
		return err
	})
	return g, err
}

// CreateGroupTx inserts a group in the caller's workspace-scoped
// transaction and writes its audit row. A SCIM actor creates a managed
// group (managed_by 'scim') and may pass the IdP's externalId; a local
// actor always creates a local group and externalID must be empty.
//
// No pre-check: the unique indexes are the only arbiters, so a create
// that loses a concurrent race gets the same error as a plain clash.
func CreateGroupTx(ctx context.Context, tx pgx.Tx, workspaceID string, actor GroupActor, displayName, externalID string) (Group, error) {
	name, err := NormalizeGroupName(displayName)
	if err != nil {
		return Group{}, err
	}
	externalID = strings.TrimSpace(externalID)
	var managed any
	if actor.scim() {
		managed = ManagedBySCIM
	} else if externalID != "" {
		return Group{}, ErrInvalid
	}
	if len([]rune(externalID)) > 256 {
		return Group{}, ErrInvalid
	}
	g, err := scanGroup(tx.QueryRow(ctx, `
		INSERT INTO workspace_groups (workspace_id, display_name, created_by, updated_by, external_id, managed_by)
		VALUES ($1::uuid, $2, NULLIF($3, '')::uuid, NULLIF($3, '')::uuid, NULLIF($4, ''), $5::text)
		RETURNING `+groupColumns,
		workspaceID, name, actorUUID(actor), externalID, managed))
	if err != nil {
		return Group{}, mapGroupErr(err)
	}
	if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupCreate, g.ID, "created", nil); err != nil {
		return Group{}, err
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
		SELECT id::text, display_name, created_at, updated_at, managed_by, COALESCE(external_id, '')
		FROM workspace_groups
		WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, workspaceID, groupID).Scan(&d.ID, &d.DisplayName, &d.CreatedAt, &d.UpdatedAt, &d.ManagedBy, &d.ExternalID)
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
	if _, err := NormalizeGroupName(displayName); err != nil {
		return Group{}, err
	}
	if !authz.ValidUUID(groupID) {
		return Group{}, ErrNotFound
	}
	var g Group
	err := p.groupTx(ctx, workspaceID, func(tx pgx.Tx) error {
		var err error
		g, err = RenameGroupTx(ctx, tx, workspaceID, actor, groupID, displayName)
		return err
	})
	return g, err
}

// RenameGroupTx sets the display name in the caller's transaction. Only
// the display name changes: the group id (what workflows target) and the
// externalId are never rewritten. A rename to the exact current name
// writes no update and no audit row.
func RenameGroupTx(ctx context.Context, tx pgx.Tx, workspaceID string, actor GroupActor, groupID, displayName string) (Group, error) {
	name, err := NormalizeGroupName(displayName)
	if err != nil {
		return Group{}, err
	}
	if !authz.ValidUUID(groupID) {
		return Group{}, ErrNotFound
	}
	g, err := scanGroup(tx.QueryRow(ctx, `
		SELECT `+groupColumns+`
		  FROM workspace_groups
		 WHERE workspace_id = $1::uuid AND id = $2::uuid
		   FOR UPDATE
	`, workspaceID, groupID))
	if err != nil {
		return Group{}, mapGroupErr(err)
	}
	if err := checkGroupActor(actor, g.ManagedBy); err != nil {
		return Group{}, err
	}
	if g.DisplayName == name {
		return g, nil
	}
	g, err = scanGroup(tx.QueryRow(ctx, `
		UPDATE workspace_groups
		   SET display_name = $3, updated_by = NULLIF($4, '')::uuid, updated_at = now()
		 WHERE workspace_id = $1::uuid AND id = $2::uuid
		RETURNING `+groupColumns,
		workspaceID, groupID, name, actorUUID(actor)))
	if err != nil {
		return Group{}, mapGroupErr(err)
	}
	if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupRename, g.ID, "updated", nil); err != nil {
		return Group{}, err
	}
	return g, nil
}

func (p *Postgres) DeleteGroup(ctx context.Context, workspaceID string, actor GroupActor, groupID string) error {
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	return p.groupTx(ctx, workspaceID, func(tx pgx.Tx) error {
		return DeleteGroupTx(ctx, tx, workspaceID, actor, groupID, time.Now())
	})
}

// DeleteGroupTx hard-deletes the group and its member rows in the
// caller's transaction. It is the one delete path for local and SCIM
// callers. Lock order: the workspace row (LockWorkspaceMembership), then
// waiting targeted gates that name the group, then the group rows. The
// gates are re-checked after the delete in the same transaction: a gate left
// with no eligible decider is closed with requirement_unresolvable /
// no_eligible_decider; one that still has a decider keeps waiting.
func DeleteGroupTx(ctx context.Context, tx pgx.Tx, workspaceID string, actor GroupActor, groupID string, now time.Time) error {
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	// Workspace row first (a no-op when a SCIM caller already holds it), so
	// a targeted gate parking now waits and resolves after this commits.
	if err := LockWorkspaceMembership(ctx, tx, workspaceID); err != nil {
		return err
	}
	managedBy, err := groupManagedByTx(ctx, tx, workspaceID, groupID)
	if err != nil {
		return err
	}
	if err := checkGroupActor(actor, managedBy); err != nil {
		return err
	}
	gates, err := approvalgate.Lock(ctx, tx, workspaceID, []string{groupID}, nil)
	if err != nil {
		return mapDBErr(err)
	}
	// Member rows and snapshot rows go with the group (ON DELETE CASCADE).
	tag, err := tx.Exec(ctx, `
		DELETE FROM workspace_groups WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, workspaceID, groupID)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := approvalgate.Recheck(ctx, tx, workspaceID, gates, now); err != nil {
		return mapDBErr(err)
	}
	return insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupDelete, groupID, "deleted", nil)
}

func (p *Postgres) AddGroupMember(ctx context.Context, workspaceID string, actor GroupActor, groupID, userID string) error {
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	add := func() error {
		return p.groupTx(ctx, workspaceID, func(tx pgx.Tx) error {
			_, err := AddGroupMemberTx(ctx, tx, workspaceID, actor, groupID, userID)
			return err
		})
	}
	err := add()
	if errors.Is(err, ErrGroupMemberNotInWorkspace) && authz.ValidUUID(userID) {
		// Retry once in a fresh transaction. SetMemberRoles replaces a
		// member's roles by deleting and reinserting their binding rows.
		// An add that was waiting on the deleted rows skips them once that
		// commits, and the reinserted rows are newer than its statement
		// snapshot, so it sees no binding for a valid member. A new
		// transaction sees the committed bindings. A real removal (or a
		// user who was never bound) is refused again.
		err = add()
	}
	return err
}

// AddGroupMemberTx adds one member row in the caller's transaction. It
// is idempotent: added is false when the row already existed, and no
// audit row is written then. The user must be active and hold a role
// binding in the workspace, or the add is ErrGroupMemberNotInWorkspace.
// Group member rows never change roles or workspace membership.
func AddGroupMemberTx(ctx context.Context, tx pgx.Tx, workspaceID string, actor GroupActor, groupID, userID string) (bool, error) {
	if !authz.ValidUUID(groupID) {
		return false, ErrNotFound
	}
	// Lock order is bindings first, then group rows, the same order as
	// RemoveMember (delete bindings, then delete group rows), so the two
	// cannot deadlock. FOR SHARE on the binding rows makes a concurrent
	// RemoveMember wait for this add to commit; its later group-row delete
	// then sees (and removes) the new row. If RemoveMember got there
	// first, this read waits for it and then finds no binding, so the add
	// is refused. No orphan row for a removed user can survive.
	bound := false
	if authz.ValidUUID(userID) {
		err := tx.QueryRow(ctx, `
			SELECT EXISTS (
			    SELECT 1
			    FROM workspace_role_bindings b
			    JOIN users u ON u.id = b.user_id
			    WHERE b.workspace_id = $1::uuid AND b.user_id = $2::uuid AND u.status = 'active'
			    FOR SHARE OF b
			)
		`, workspaceID, userID).Scan(&bound)
		if err != nil {
			return false, mapDBErr(err)
		}
	}
	// Group rows only after the binding lock. A missing group is still
	// 404 ahead of the member check, and a managed group is refused
	// before it too.
	managedBy, err := groupManagedByTx(ctx, tx, workspaceID, groupID)
	if err != nil {
		return false, err
	}
	if err := checkGroupActor(actor, managedBy); err != nil {
		return false, err
	}
	if !bound {
		return false, ErrGroupMemberNotInWorkspace
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO workspace_group_members (workspace_id, group_id, user_id, added_by)
		VALUES ($1::uuid, $2::uuid, $3::uuid, NULLIF($4, '')::uuid)
		ON CONFLICT (workspace_id, group_id, user_id) DO NOTHING
	`, workspaceID, groupID, userID, actorUUID(actor))
	if err != nil {
		return false, mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupMemberAdd, groupID, "added", map[string]string{"userId": userID}); err != nil {
		return false, err
	}
	return true, nil
}

func (p *Postgres) RemoveGroupMember(ctx context.Context, workspaceID string, actor GroupActor, groupID, userID string) error {
	// A groupId that is not a UUID is not-found, like other resource
	// ids. A userId that is not a UUID is invalid, like RemoveMember.
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	if !authz.ValidUUID(userID) {
		return ErrInvalid
	}
	return p.groupTx(ctx, workspaceID, func(tx pgx.Tx) error {
		_, err := RemoveGroupMemberTx(ctx, tx, workspaceID, actor, groupID, userID, time.Now())
		return err
	})
}

// RemoveGroupMemberTx removes one member row in the caller's
// transaction. It is the one member-removal path for local and SCIM
// callers, and it is idempotent: removed is false (and no audit row is
// written) when there was no row. Waiting targeted gates that name the
// group are locked before the delete and re-checked after it, the same
// as DeleteGroupTx. Roles and workspace membership never change here.
func RemoveGroupMemberTx(ctx context.Context, tx pgx.Tx, workspaceID string, actor GroupActor, groupID, userID string, now time.Time) (bool, error) {
	if !authz.ValidUUID(groupID) {
		return false, ErrNotFound
	}
	if !authz.ValidUUID(userID) {
		return false, ErrInvalid
	}
	// Workspace row first, as in DeleteGroupTx.
	if err := LockWorkspaceMembership(ctx, tx, workspaceID); err != nil {
		return false, err
	}
	managedBy, err := groupManagedByTx(ctx, tx, workspaceID, groupID)
	if err != nil {
		return false, err
	}
	if err := checkGroupActor(actor, managedBy); err != nil {
		return false, err
	}
	gates, err := approvalgate.Lock(ctx, tx, workspaceID, []string{groupID}, nil)
	if err != nil {
		return false, mapDBErr(err)
	}
	tag, err := tx.Exec(ctx, `
		DELETE FROM workspace_group_members
		 WHERE workspace_id = $1::uuid AND group_id = $2::uuid AND user_id = $3::uuid
	`, workspaceID, groupID, userID)
	if err != nil {
		return false, mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if _, err := approvalgate.Recheck(ctx, tx, workspaceID, gates, now); err != nil {
		return false, mapDBErr(err)
	}
	if err := insertGroupAudit(ctx, tx, workspaceID, actor, AuditGroupMemberRemove, groupID, "removed", map[string]string{"userId": userID}); err != nil {
		return false, err
	}
	return true, nil
}

// groupTx runs fn in a transaction scoped to workspaceID and commits.
func (p *Postgres) groupTx(ctx context.Context, workspaceID string, fn func(pgx.Tx) error) error {
	tx, err := p.beginGroupTx(ctx, workspaceID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return mapGroupErr(tx.Commit(ctx))
}

// groupColumns is the Group projection; scanGroup reads it.
const groupColumns = `id::text, display_name, created_at, updated_at,
	(SELECT count(*) FROM workspace_group_members m
	  WHERE m.workspace_id = workspace_groups.workspace_id AND m.group_id = workspace_groups.id)::int,
	managed_by, COALESCE(external_id, '')`

func scanGroup(row pgx.Row) (Group, error) {
	var g Group
	err := row.Scan(&g.ID, &g.DisplayName, &g.CreatedAt, &g.UpdatedAt, &g.MemberCount, &g.ManagedBy, &g.ExternalID)
	return g, err
}

// groupManagedByTx reads managed_by for an existing group. managed_by is
// set only on create and never changes, so a plain read is enough.
func groupManagedByTx(ctx context.Context, tx pgx.Tx, workspaceID, groupID string) (*string, error) {
	var managedBy *string
	err := tx.QueryRow(ctx, `
		SELECT managed_by FROM workspace_groups WHERE workspace_id = $1::uuid AND id = $2::uuid
	`, workspaceID, groupID).Scan(&managedBy)
	if err != nil {
		return nil, mapDBErr(err)
	}
	return managedBy, nil
}

// checkGroupActor is the managed-group rule. A SCIM actor sees only
// managed groups: anything else is ErrNotFound. A local actor is refused
// on a managed group while the instance is in groups mode; in workspaces
// mode the marker is kept but not enforced.
func checkGroupActor(actor GroupActor, managedBy *string) error {
	managed := managedBy != nil && *managedBy == ManagedBySCIM
	if actor.scim() {
		if !managed {
			return ErrNotFound
		}
		return nil
	}
	if managed && actor.SCIMGroupsMode {
		return ErrGroupManagedBySCIM
	}
	return nil
}

// insertGroupAudit writes one audit_events row in the caller's scoped
// transaction. Details are ids only: groupId plus userId for member rows,
// plus tokenId and via=scim_token when a workspace SCIM token acted.
func insertGroupAudit(ctx context.Context, tx pgx.Tx, workspaceID string, actor GroupActor, action, groupID, outcome string, extra map[string]string) error {
	details := map[string]string{"groupId": groupID}
	for k, v := range extra {
		details[k] = v
	}
	if actor.scim() {
		// The token is the actor: its row id (a UUID), never the token.
		details["tokenId"] = strings.ToLower(strings.TrimSpace(actor.SCIMTokenID))
		details["via"] = "scim_token"
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

// mapGroupErr maps the display-name unique index to ErrGroupNameTaken
// and the externalId index to ErrGroupExternalIDTaken.
// Every other error keeps the identity mapping.
func mapGroupErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		switch pgErr.ConstraintName {
		case groupNameIndex:
			return ErrGroupNameTaken
		case groupExternalIDIndex:
			return ErrGroupExternalIDTaken
		}
	}
	return mapDBErr(err)
}
