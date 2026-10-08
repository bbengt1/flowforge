package identity

import (
	"context"
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

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Postgres persists identity and RBAC in PostgreSQL.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) UpsertUser(ctx context.Context, issuer, subject, displayName string) (User, error) {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	displayName = strings.TrimSpace(displayName)
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) || len(displayName) > 200 {
		return User{}, ErrInvalid
	}
	var u User
	err := p.db.QueryRow(ctx, `
		INSERT INTO users (issuer, external_subject, display_name)
		VALUES ($1, $2, $3)
		ON CONFLICT (issuer, external_subject) DO UPDATE
		    SET display_name = CASE
		        WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name
		        ELSE users.display_name
		    END,
		    updated_at = now()
		RETURNING id::text, issuer, external_subject, display_name, status, created_at, updated_at
	`, issuer, subject, displayName).Scan(
		&u.ID, &u.Issuer, &u.ExternalSubject, &u.DisplayName, &u.Status, &u.CreatedAt, &u.UpdatedAt,
	)
	if err != nil {
		return User{}, mapDBErr(err)
	}
	return u, nil
}

func (p *Postgres) GetUser(ctx context.Context, id string) (User, error) {
	var u User
	err := p.db.QueryRow(ctx, `
		SELECT id::text, issuer, external_subject, display_name, status, created_at, updated_at
		FROM users WHERE id = $1::uuid
	`, id).Scan(&u.ID, &u.Issuer, &u.ExternalSubject, &u.DisplayName, &u.Status, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return User{}, mapDBErr(err)
	}
	return u, nil
}

func (p *Postgres) SetUserStatus(ctx context.Context, userID, status string) error {
	userID = strings.TrimSpace(userID)
	status = strings.TrimSpace(status)
	if userID == "" || (status != "active" && status != "disabled") {
		return ErrInvalid
	}
	tag, err := p.db.Exec(ctx, `
		UPDATE users SET status = $2, updated_at = now() WHERE id = $1::uuid
	`, userID, status)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// FindUser returns an existing principal. It does not upsert.
func (p *Postgres) FindUser(ctx context.Context, issuer, subject string) (User, error) {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		return User{}, ErrInvalid
	}
	var u User
	err := p.db.QueryRow(ctx, `
		SELECT id::text, issuer, external_subject, display_name, status, created_at, updated_at
		FROM users WHERE issuer = $1 AND external_subject = $2
	`, issuer, subject).Scan(&u.ID, &u.Issuer, &u.ExternalSubject, &u.DisplayName, &u.Status, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return User{}, mapDBErr(err)
	}
	return u, nil
}

func (p *Postgres) SetLocalPassword(ctx context.Context, userID, identifier, passwordHash string) error {
	userID = strings.TrimSpace(userID)
	identifier = strings.TrimSpace(identifier)
	passwordHash = strings.TrimSpace(passwordHash)
	if userID == "" || identifier == "" || passwordHash == "" {
		return ErrInvalid
	}
	_, err := p.db.Exec(ctx, `
		INSERT INTO local_logins (user_id, identifier, password_hash, must_change_password)
		VALUES ($1::uuid, $2, $3, false)
		ON CONFLICT (user_id) DO UPDATE
		    SET identifier = EXCLUDED.identifier,
		        password_hash = EXCLUDED.password_hash,
		        must_change_password = false,
		        updated_at = now()
	`, userID, identifier, passwordHash)
	if err != nil {
		return mapDBErr(err)
	}
	return nil
}

func (p *Postgres) LookupLocalLogin(ctx context.Context, identifier string) (LocalLogin, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return LocalLogin{}, ErrNotFound
	}
	return p.scanLocalLogin(ctx, `
		SELECT u.id::text, u.issuer, u.external_subject, u.display_name, u.status,
		       u.created_at, u.updated_at, l.identifier, l.password_hash, l.must_change_password
		FROM local_logins l
		JOIN users u ON u.id = l.user_id
		WHERE lower(l.identifier) = $1
	`, identifier)
}

func (p *Postgres) LookupLocalLoginByUser(ctx context.Context, userID string) (LocalLogin, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return LocalLogin{}, ErrNotFound
	}
	return p.scanLocalLogin(ctx, `
		SELECT u.id::text, u.issuer, u.external_subject, u.display_name, u.status,
		       u.created_at, u.updated_at, l.identifier, l.password_hash, l.must_change_password
		FROM local_logins l
		JOIN users u ON u.id = l.user_id
		WHERE l.user_id = $1::uuid
	`, userID)
}

func (p *Postgres) scanLocalLogin(ctx context.Context, query string, arg any) (LocalLogin, error) {
	var out LocalLogin
	err := p.db.QueryRow(ctx, query, arg).Scan(
		&out.User.ID, &out.User.Issuer, &out.User.ExternalSubject, &out.User.DisplayName, &out.User.Status,
		&out.User.CreatedAt, &out.User.UpdatedAt, &out.Identifier, &out.PasswordHash, &out.MustChangePassword,
	)
	if err != nil {
		return LocalLogin{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) HasLocalLogins(ctx context.Context) (bool, error) {
	var n int
	err := p.db.QueryRow(ctx, `SELECT COUNT(*) FROM local_logins`).Scan(&n)
	if err != nil {
		return false, mapDBErr(err)
	}
	return n > 0, nil
}

func (p *Postgres) InsertBootstrapLocalLogin(ctx context.Context, userID, identifier, passwordHash string) (bool, error) {
	userID = strings.TrimSpace(userID)
	identifier = strings.TrimSpace(identifier)
	passwordHash = strings.TrimSpace(passwordHash)
	if userID == "" || identifier == "" || passwordHash == "" {
		return false, ErrInvalid
	}
	tag, err := p.db.Exec(ctx, `
		INSERT INTO local_logins (user_id, identifier, password_hash, must_change_password)
		SELECT $1::uuid, $2, $3, false
		WHERE NOT EXISTS (SELECT 1 FROM local_logins)
	`, userID, identifier, passwordHash)
	if err != nil {
		return false, mapDBErr(err)
	}
	return tag.RowsAffected() > 0, nil
}

func (p *Postgres) ChangeLocalPassword(ctx context.Context, userID, passwordHash string) error {
	userID = strings.TrimSpace(userID)
	passwordHash = strings.TrimSpace(passwordHash)
	if userID == "" || passwordHash == "" {
		return ErrInvalid
	}
	tag, err := p.db.Exec(ctx, `
		UPDATE local_logins
		   SET password_hash = $2,
		       must_change_password = false,
		       updated_at = now()
		 WHERE user_id = $1::uuid
	`, userID, passwordHash)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) RequireLocalPasswordChange(ctx context.Context, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ErrInvalid
	}
	tag, err := p.db.Exec(ctx, `
		UPDATE local_logins
		   SET must_change_password = true,
		       updated_at = now()
		 WHERE user_id = $1::uuid
	`, userID)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) CreateTenant(ctx context.Context, slug, name string) (Tenant, error) {
	slug = strings.TrimSpace(slug)
	name = strings.TrimSpace(name)
	if !authz.ValidTenantSlug(slug) || name == "" || len(name) > 200 {
		return Tenant{}, ErrInvalid
	}
	var t Tenant
	err := p.db.QueryRow(ctx, `
		INSERT INTO tenants (slug, name) VALUES ($1, $2)
		RETURNING id::text, slug, name, status, created_at, updated_at
	`, slug, name).Scan(&t.ID, &t.Slug, &t.Name, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return Tenant{}, mapDBErr(err)
	}
	return t, nil
}

func (p *Postgres) GetTenant(ctx context.Context, id string) (Tenant, error) {
	var t Tenant
	err := p.db.QueryRow(ctx, `
		SELECT id::text, slug, name, status, created_at, updated_at
		FROM tenants WHERE id = $1::uuid
	`, id).Scan(&t.ID, &t.Slug, &t.Name, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return Tenant{}, mapDBErr(err)
	}
	return t, nil
}

func (p *Postgres) GetTenantBySlug(ctx context.Context, slug string) (Tenant, error) {
	var t Tenant
	err := p.db.QueryRow(ctx, `
		SELECT id::text, slug, name, status, created_at, updated_at
		FROM tenants WHERE slug = $1
	`, slug).Scan(&t.ID, &t.Slug, &t.Name, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return Tenant{}, mapDBErr(err)
	}
	return t, nil
}

func (p *Postgres) CreateWorkspace(ctx context.Context, tenantID, workbenchKey, name, creatorUserID string) (Workspace, error) {
	workbenchKey = strings.TrimSpace(workbenchKey)
	name = strings.TrimSpace(name)
	if !authz.ValidWorkbenchKey(workbenchKey) || name == "" || len(name) > 200 {
		return Workspace{}, ErrInvalid
	}

	tx, err := p.db.Begin(ctx)
	if err != nil {
		return Workspace{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var tenantStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id = $1::uuid`, tenantID).Scan(&tenantStatus); err != nil {
		return Workspace{}, mapDBErr(err)
	}
	if tenantStatus != "active" {
		return Workspace{}, ErrDisabled
	}
	var userExists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM users WHERE id = $1::uuid`, creatorUserID).Scan(&userExists); err != nil {
		return Workspace{}, mapDBErr(err)
	}

	var ws Workspace
	err = tx.QueryRow(ctx, `
		INSERT INTO workspaces (tenant_id, workbench_key, name)
		VALUES ($1::uuid, $2, $3)
		RETURNING id::text, tenant_id::text, workbench_key, name, status, created_at, updated_at
	`, tenantID, workbenchKey, name).Scan(
		&ws.ID, &ws.TenantID, &ws.WorkbenchKey, &ws.Name, &ws.Status, &ws.CreatedAt, &ws.UpdatedAt,
	)
	if err != nil {
		return Workspace{}, mapDBErr(err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_role_bindings (workspace_id, user_id, role_id)
		SELECT $1::uuid, $2::uuid, r.id FROM roles r WHERE r.key = $3
	`, ws.ID, creatorUserID, authz.RoleAdmin); err != nil {
		return Workspace{}, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, mapDBErr(err)
	}
	return ws, nil
}

func (p *Postgres) ResolveWorkspace(ctx context.Context, tenantID, tenantSlug, workbenchKey string) (Workspace, Tenant, error) {
	var (
		ws        Workspace
		t         Tenant
		tenantArg any
	)
	if tenantID != "" {
		tenantArg = tenantID
	}
	err := p.db.QueryRow(ctx, `
		SELECT w.id::text, w.tenant_id::text, w.workbench_key, w.name, w.status, w.created_at, w.updated_at,
		       t.id::text, t.slug, t.name, t.status, t.created_at, t.updated_at
		FROM workspaces w
		JOIN tenants t ON t.id = w.tenant_id
		WHERE w.workbench_key = $1
		  AND ($2::uuid IS NULL OR t.id = $2::uuid)
		  AND ($3 = '' OR t.slug = $3)
	`, workbenchKey, tenantArg, tenantSlug).Scan(
		&ws.ID, &ws.TenantID, &ws.WorkbenchKey, &ws.Name, &ws.Status, &ws.CreatedAt, &ws.UpdatedAt,
		&t.ID, &t.Slug, &t.Name, &t.Status, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return Workspace{}, Tenant{}, mapDBErr(err)
	}
	return ws, t, nil
}

func (p *Postgres) GetWorkspace(ctx context.Context, id string) (Workspace, error) {
	var ws Workspace
	err := p.db.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, workbench_key, name, status, created_at, updated_at
		FROM workspaces WHERE id = $1::uuid
	`, id).Scan(&ws.ID, &ws.TenantID, &ws.WorkbenchKey, &ws.Name, &ws.Status, &ws.CreatedAt, &ws.UpdatedAt)
	if err != nil {
		return Workspace{}, mapDBErr(err)
	}
	return ws, nil
}

func (p *Postgres) ListActiveWorkspaces(ctx context.Context) ([]Workspace, error) {
	rows, err := p.db.Query(ctx, `
		SELECT w.id::text, w.tenant_id::text, w.workbench_key, w.name, w.status, w.created_at, w.updated_at
		FROM workspaces w
		JOIN tenants t ON t.id = w.tenant_id
		WHERE w.status = 'active' AND t.status = 'active'
		ORDER BY w.created_at, w.id
	`)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Workspace
	for rows.Next() {
		var ws Workspace
		if err := rows.Scan(&ws.ID, &ws.TenantID, &ws.WorkbenchKey, &ws.Name, &ws.Status, &ws.CreatedAt, &ws.UpdatedAt); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, ws)
	}
	if out == nil {
		out = []Workspace{}
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) DeleteWorkspace(ctx context.Context, id string) (Workspace, error) {
	var ws Workspace
	err := p.db.QueryRow(ctx, `
		UPDATE workspaces
		   SET status = 'disabled',
		       updated_at = now()
		 WHERE id = $1::uuid
		 RETURNING id::text, tenant_id::text, workbench_key, name, status, created_at, updated_at
	`, id).Scan(&ws.ID, &ws.TenantID, &ws.WorkbenchKey, &ws.Name, &ws.Status, &ws.CreatedAt, &ws.UpdatedAt)
	if err != nil {
		return Workspace{}, mapDBErr(err)
	}
	return ws, nil
}

func (p *Postgres) ListWorkspacesForUser(ctx context.Context, userID string) ([]Membership, error) {
	items, _, err := p.ListWorkspacesForUserPage(ctx, userID, page.Query{})
	return items, err
}

func (p *Postgres) ListWorkspacesForUserPage(ctx context.Context, userID string, q page.Query) ([]Membership, string, error) {
	if q.Bound && (q.Limit < 1 || q.Limit > page.MaxLimit) {
		return nil, "", page.ErrInvalid
	}
	args := []any{userID}
	sql := `
		SELECT w.id::text, w.tenant_id::text, w.workbench_key, w.name, w.status, w.created_at, w.updated_at,
		       t.id::text, t.slug, t.name, t.status, t.created_at, t.updated_at,
		       ARRAY(SELECT r.key FROM workspace_role_bindings b2
		             JOIN roles r ON r.id = b2.role_id
		             WHERE b2.workspace_id = w.id AND b2.user_id = $1::uuid
		             ORDER BY r.key)
		FROM workspaces w
		JOIN tenants t ON t.id = w.tenant_id
		WHERE EXISTS (
		    SELECT 1 FROM workspace_role_bindings b
		    WHERE b.workspace_id = w.id AND b.user_id = $1::uuid
		)`
	if pred := page.SearchPredicate(&args, q.Q, "w.name", "w.workbench_key"); pred != "" {
		sql += " AND " + pred
	}
	order := ` ORDER BY w.created_at`
	if q.Bound {
		keyset, err := page.AscTimePredicate(&args, page.ColWorkspace, "w.created_at", "w.id", q.Cursor)
		if err != nil {
			return nil, "", err
		}
		if keyset != "" {
			sql += " AND " + keyset
		}
		order = ` ORDER BY w.created_at ASC, w.id ASC` + page.LimitSQL(&args, q)
	}
	rows, err := p.db.Query(ctx, sql+order, args...)
	if err != nil {
		return nil, "", mapDBErr(err)
	}
	defer rows.Close()
	var out []Membership
	for rows.Next() {
		var m Membership
		if err := rows.Scan(
			&m.Workspace.ID, &m.Workspace.TenantID, &m.Workspace.WorkbenchKey, &m.Workspace.Name,
			&m.Workspace.Status, &m.Workspace.CreatedAt, &m.Workspace.UpdatedAt,
			&m.Tenant.ID, &m.Tenant.Slug, &m.Tenant.Name, &m.Tenant.Status, &m.Tenant.CreatedAt, &m.Tenant.UpdatedAt,
			&m.Roles,
		); err != nil {
			return nil, "", mapDBErr(err)
		}
		m.Permissions = authz.ExpandWorkspaceRoles(m.Roles)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if !q.Bound {
		if out == nil {
			out = []Membership{}
		}
		return out, "", nil
	}
	return page.Trim(page.ColWorkspace, q, out, func(m Membership) page.Key {
		return page.Key{K: page.TimeKey(m.Workspace.CreatedAt), ID: m.Workspace.ID}
	})
}

func (p *Postgres) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := p.db.Query(ctx, `
		SELECT r.key, r.description,
		       ARRAY(SELECT p.key FROM role_permissions rp
		             JOIN permissions p ON p.id = rp.permission_id
		             WHERE rp.role_id = r.id
		             ORDER BY p.key)
		FROM roles r
		ORDER BY r.key
	`)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Role
	for rows.Next() {
		var r Role
		if err := rows.Scan(&r.Key, &r.Description, &r.Permissions); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *Postgres) ListPermissions(ctx context.Context) ([]Permission, error) {
	rows, err := p.db.Query(ctx, `SELECT key FROM permissions ORDER BY key`)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Permission
	for rows.Next() {
		var perm Permission
		if err := rows.Scan(&perm.Key); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, perm)
	}
	return out, rows.Err()
}

func (p *Postgres) EffectiveAccess(ctx context.Context, workspaceID, userID string) (roles, perms []string, err error) {
	var wsStatus, userStatus string
	err = p.db.QueryRow(ctx, `
		SELECT w.status, u.status
		FROM workspaces w, users u
		WHERE w.id = $1::uuid AND u.id = $2::uuid
	`, workspaceID, userID).Scan(&wsStatus, &userStatus)
	if err != nil {
		return nil, nil, mapDBErr(err)
	}
	if wsStatus != "active" || userStatus != "active" {
		return nil, nil, ErrDisabled
	}
	rows, err := p.db.Query(ctx, `
		SELECT r.key
		FROM workspace_role_bindings b
		JOIN roles r ON r.id = b.role_id
		WHERE b.workspace_id = $1::uuid AND b.user_id = $2::uuid
		ORDER BY r.key
	`, workspaceID, userID)
	if err != nil {
		return nil, nil, mapDBErr(err)
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, nil, mapDBErr(err)
		}
		roles = append(roles, key)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return roles, authz.ExpandWorkspaceRoles(roles), nil
}

func (p *Postgres) ListMembers(ctx context.Context, workspaceID string) ([]Member, error) {
	items, _, err := p.ListMembersPage(ctx, workspaceID, page.Query{})
	return items, err
}

func (p *Postgres) ListMembersPage(ctx context.Context, workspaceID string, q page.Query) ([]Member, string, error) {
	if _, err := p.GetWorkspace(ctx, workspaceID); err != nil {
		return nil, "", err
	}
	if q.Bound && (q.Limit < 1 || q.Limit > page.MaxLimit) {
		return nil, "", page.ErrInvalid
	}
	args := []any{workspaceID}
	sql := `
		SELECT u.id::text, u.issuer, u.external_subject, u.display_name, u.status, u.created_at, u.updated_at,
		       ARRAY(SELECT r.key FROM workspace_role_bindings b2
		             JOIN roles r ON r.id = b2.role_id
		             WHERE b2.workspace_id = $1::uuid AND b2.user_id = u.id
		             ORDER BY r.key)
		FROM users u
		WHERE EXISTS (
		    SELECT 1 FROM workspace_role_bindings b
		    WHERE b.workspace_id = $1::uuid AND b.user_id = u.id
		)`
	if pred := page.SearchPredicate(&args, q.Q, "u.display_name"); pred != "" {
		sql += " AND " + pred
	}
	order := ` ORDER BY u.created_at`
	if q.Bound {
		keyset, err := page.AscTimePredicate(&args, page.ColMember, "u.created_at", "u.id", q.Cursor)
		if err != nil {
			return nil, "", err
		}
		if keyset != "" {
			sql += " AND " + keyset
		}
		order = ` ORDER BY u.created_at ASC, u.id ASC` + page.LimitSQL(&args, q)
	}
	rows, err := p.db.Query(ctx, sql+order, args...)
	if err != nil {
		return nil, "", mapDBErr(err)
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(
			&m.User.ID, &m.User.Issuer, &m.User.ExternalSubject, &m.User.DisplayName,
			&m.User.Status, &m.User.CreatedAt, &m.User.UpdatedAt, &m.Roles,
		); err != nil {
			return nil, "", mapDBErr(err)
		}
		m.Permissions = authz.ExpandWorkspaceRoles(m.Roles)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if !q.Bound {
		return out, "", nil
	}
	return page.Trim(page.ColMember, q, out, func(m Member) page.Key {
		return page.Key{K: page.TimeKey(m.User.CreatedAt), ID: m.User.ID}
	})
}

// SetMemberRoles replaces a member's roles in one workspace-scoped
// transaction (FORCE RLS on the approval tables applies, so the gate
// re-check sees this workspace's gates). Lock order is the same as a
// membership loss: the workspace row first (LockWorkspaceMembership),
// then waiting gates (gatesForRoleLoss), then the binding rows. A change
// that removes any role re-checks those gates after the new bindings are
// written: a gate left with no eligible decider is closed with
// requirement_unresolvable / no_eligible_decider, exactly like a removal.
// A promotion or an unchanged role set locks and re-checks nothing.
func (p *Postgres) SetMemberRoles(ctx context.Context, workspaceID, userID string, roleKeys []string) error {
	if err := validateRoleKeys(roleKeys); err != nil {
		return err
	}
	if !authz.ValidUUID(workspaceID) {
		return ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, workspaceID)
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	// Replacing roles can demote an admin: lock the workspace row before
	// touching any binding (see LockWorkspaceMembership).
	if err := LockWorkspaceMembership(ctx, tx, workspaceID); err != nil {
		return err
	}
	if err := mustExist(ctx, tx, `SELECT 1 FROM users WHERE id = $1::uuid`, userID); err != nil {
		return err
	}
	next := uniqueSorted(roleKeys)
	current, err := memberRoleKeysTx(ctx, tx, workspaceID, userID)
	if err != nil {
		return err
	}
	var gates []approvalgate.Gate
	if lostAnyRole(current, next) {
		gates, err = gatesForRoleLoss(ctx, tx, workspaceID, userID, current, next)
		if err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid
	`, workspaceID, userID); err != nil {
		return mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_role_bindings (workspace_id, user_id, role_id)
		SELECT $1::uuid, $2::uuid, r.id FROM roles r WHERE r.key = ANY($3::text[])
	`, workspaceID, userID, next); err != nil {
		return mapDBErr(err)
	}
	if err := ensureAdmin(ctx, tx, workspaceID); err != nil {
		return err
	}
	if _, err := approvalgate.Recheck(ctx, tx, workspaceID, gates, time.Now()); err != nil {
		return mapDBErr(err)
	}
	return tx.Commit(ctx)
}

// memberRoleKeysTx reads the user's role keys in the workspace. The
// caller holds the workspace-row lock, so no other binding writer can
// change them before this transaction ends.
func memberRoleKeysTx(ctx context.Context, tx pgx.Tx, workspaceID, userID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT r.key
		  FROM workspace_role_bindings b
		  JOIN roles r ON r.id = b.role_id
		 WHERE b.workspace_id = $1::uuid AND b.user_id = $2::uuid
		 ORDER BY r.key
	`, workspaceID, userID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, k)
	}
	return out, mapDBErr(rows.Err())
}

func lostAnyRole(current, next []string) bool {
	for _, k := range current {
		if !containsKey(next, k) {
			return true
		}
	}
	return false
}

func containsKey(keys []string, k string) bool {
	for _, x := range keys {
		if x == k {
			return true
		}
	}
	return false
}

// gatesForRoleLoss locks the waiting targeted gates whose decider set can
// shrink when userID goes from the current role keys to next (nil for a
// removal). The caller holds the workspace-row lock; this runs before any
// binding is touched, keeping the order workspace -> link -> gates ->
// bindings -> group rows.
//
//   - Always: gates that name the user, or a group the user is in.
//   - The user loses admin: an active admin other than the requester can
//     decide any gate by override (parkedapproval.OtherActiveAdmin), so
//     count the OTHER active admins left (same rule: role admin, user
//     active, live binding). Two or more: every gate keeps a non-requester
//     admin, nothing more is locked. Exactly one (X): the fallback is gone
//     only for gates X requested, so those are locked too. None: every
//     waiting targeted gate is locked. If no workspace.administer binding
//     is left at all, GuardLastAdmin then refuses and the transaction
//     rolls back, so nothing is closed.
func gatesForRoleLoss(ctx context.Context, tx pgx.Tx, workspaceID, userID string, current, next []string) ([]approvalgate.Gate, error) {
	sel := approvalgate.Selection{Users: []string{userID}}
	if containsKey(current, authz.RoleAdmin) && !containsKey(next, authz.RoleAdmin) {
		others, err := otherActiveAdminsTx(ctx, tx, workspaceID, userID)
		if err != nil {
			return nil, err
		}
		switch len(others) {
		case 0:
			sel.All = true
		case 1:
			sel.RequestedBy = others
		}
	}
	gates, err := approvalgate.LockSelected(ctx, tx, workspaceID, sel)
	if err != nil {
		return nil, mapDBErr(err)
	}
	return gates, nil
}

// otherActiveAdminsTx returns up to two active admins in the workspace
// other than userID, with the eligibility rule of
// parkedapproval.OtherActiveAdmin (role admin, user active, live binding).
func otherActiveAdminsTx(ctx context.Context, tx pgx.Tx, workspaceID, userID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT b.user_id::text
		  FROM workspace_role_bindings b
		  JOIN roles r ON r.id = b.role_id
		  JOIN users u ON u.id = b.user_id
		 WHERE b.workspace_id = $1::uuid
		   AND r.key = 'admin'
		   AND u.status = 'active'
		   AND b.user_id <> $2::uuid
		 ORDER BY 1
		 LIMIT 2
	`, workspaceID, userID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, id)
	}
	return out, mapDBErr(rows.Err())
}

// RemoveMember deletes the user's role bindings and their workspace group
// rows in one transaction scoped to workspaceID, so FORCE RLS on the group
// tables applies. SCIM deprovision calls this once per workspace and gets
// the same cleanup. Lock order is the workspace row first
// (LockWorkspaceMembership), then bindings, then group rows. Bindings
// before group rows is the same order as AddGroupMember, so the two
// cannot deadlock: a concurrent add holds FOR SHARE on the binding rows,
// this waits for it, and the group-row delete that follows sees the new
// row. ErrLastAdmin rolls back both deletes.
func (p *Postgres) RemoveMember(ctx context.Context, workspaceID, userID string) error {
	if !authz.ValidUUID(workspaceID) || !authz.ValidUUID(userID) {
		return ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, workspaceID)
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	if err := LockWorkspaceMembership(ctx, tx, workspaceID); err != nil {
		return err
	}
	removed, err := RemoveMembershipTx(ctx, tx, workspaceID, userID, time.Now())
	if err != nil {
		return err
	}
	if !removed {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RemoveMembershipTx is the one membership-loss path: admin removal
// (RemoveMember), SCIM active:false, and SCIM DELETE all call it, in
// either SCIM_GROUPS_MODE. The caller must already hold the workspace-row
// lock (LockWorkspaceMembership) and, for SCIM, the link row.
//
// Lock order after that: waiting targeted gates that name the user or a
// group the user is in (executions, then approvals), then the user's
// role bindings, then group rows (local and SCIM-managed alike). The last-
// admin guard runs after the binding delete. After the group rows are
// gone the locked gates are re-checked in the same transaction; a gate
// left with no eligible decider is closed with requirement_unresolvable /
// no_eligible_decider, and one that still has a decider keeps waiting.
//
// Losing an admin also re-checks the gates whose admin fallback goes
// with it (gatesForRoleLoss), bounded by how many other active admins
// are left.
//
// Bindings MUST be deleted before group rows. A concurrent local
// AddGroupMember takes no workspace lock: it reads the user's binding
// FOR SHARE, then inserts the group row. If the add holds that share
// lock first, the binding DELETE here waits for the add to commit, and
// the group-row DELETE that follows (a new statement under READ
// COMMITTED) sees the committed row and removes it. If this DELETE runs
// first, the add waits on it and then finds no binding and is refused.
// Either way no group row survives for a removed member. Deleting group
// rows first would let an add commit a row after that DELETE and leave
// it behind. A gate that parks while this runs waits on the workspace
// row (parkedapproval.LockWorkspaceForPark) and resolves after commit.
//
// removed reports whether any role binding was deleted. Group rows are
// deleted either way, so a link left without a role never keeps them.
func RemoveMembershipTx(ctx context.Context, tx pgx.Tx, workspaceID, userID string, now time.Time) (bool, error) {
	if !authz.ValidUUID(workspaceID) || !authz.ValidUUID(userID) {
		return false, ErrInvalid
	}
	current, err := memberRoleKeysTx(ctx, tx, workspaceID, userID)
	if err != nil {
		return false, err
	}
	gates, err := gatesForRoleLoss(ctx, tx, workspaceID, userID, current, nil)
	if err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `
		DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid
	`, workspaceID, userID)
	if err != nil {
		return false, mapDBErr(err)
	}
	removed := tag.RowsAffected() > 0
	if removed {
		if err := ensureAdmin(ctx, tx, workspaceID); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM workspace_group_members WHERE workspace_id = $1::uuid AND user_id = $2::uuid
	`, workspaceID, userID); err != nil {
		return false, mapDBErr(err)
	}
	if _, err := approvalgate.Recheck(ctx, tx, workspaceID, gates, now); err != nil {
		return false, mapDBErr(err)
	}
	return removed, nil
}

func (p *Postgres) ResolveUserRef(ctx context.Context, userID, issuer, subject, displayName string) (User, error) {
	if strings.TrimSpace(userID) != "" {
		return p.GetUser(ctx, strings.TrimSpace(userID))
	}
	return p.UpsertUser(ctx, issuer, subject, displayName)
}

func mustExist(ctx context.Context, tx pgx.Tx, sql, id string) error {
	var n int
	if err := tx.QueryRow(ctx, sql, id).Scan(&n); err != nil {
		return mapDBErr(err)
	}
	return nil
}

func ensureAdmin(ctx context.Context, tx pgx.Tx, workspaceID string) error {
	return GuardLastAdmin(ctx, tx, workspaceID)
}

// LockWorkspaceMembership locks the workspace row (FOR NO KEY UPDATE) in
// tx. Every transaction that can lower a workspace's administrator count
// (role-binding removal, role replacement, SCIM deactivate/delete/group
// remove) takes this lock FIRST, before it reads, deletes, or replaces
// any role binding, so all of them serialize on one row and lock in the
// same order: workspace row, then link or binding rows, then group rows.
//
// The second of two concurrent transactions waits here until the first
// commits; under READ COMMITTED its later statements then see the
// first's changes, so its last-admin count is correct. Without the lock,
// two removals of the only two admins could each count the other and
// both commit.
//
// FOR NO KEY UPDATE conflicts with itself (and with FOR UPDATE), so the
// serialization is the same as FOR UPDATE, but it does not conflict with
// the FOR KEY SHARE that foreign-key checks take. Inserts elsewhere that
// reference the workspace (runs, audit rows) are therefore not blocked,
// and a transaction that already holds such a key-share lock cannot
// deadlock against this one. workspaces has no RLS, so the lock works
// the same inside a workspace-scoped transaction. A row lock needs UPDATE
// privilege, which flowforge_app has (approle.go). If RLS is ever added to
// workspaces, this SELECT ... FOR NO KEY UPDATE also needs an UPDATE policy
// that admits the row, or the lock silently finds nothing and returns
// ErrNotFound.
//
// ErrNotFound means the workspace does not exist.
func LockWorkspaceMembership(ctx context.Context, tx pgx.Tx, workspaceID string) error {
	if !authz.ValidUUID(workspaceID) {
		return ErrInvalid
	}
	var locked int
	if err := tx.QueryRow(ctx, `
		SELECT 1 FROM workspaces WHERE id = $1::uuid FOR NO KEY UPDATE
	`, workspaceID).Scan(&locked); err != nil {
		return mapDBErr(err)
	}
	return nil
}

// GuardLastAdmin counts distinct users who still hold
// workspace.administer in tx and returns ErrLastAdmin when none remain;
// the caller must roll back. The caller must already hold
// LockWorkspaceMembership from the start of the transaction. The guard
// takes it again (a no-op for the holder) so a caller that forgot cannot
// count unlocked.
func GuardLastAdmin(ctx context.Context, tx pgx.Tx, workspaceID string) error {
	if err := LockWorkspaceMembership(ctx, tx, workspaceID); err != nil {
		return err
	}
	var n int
	err := tx.QueryRow(ctx, `
		SELECT COUNT(DISTINCT b.user_id)
		FROM workspace_role_bindings b
		JOIN role_permissions rp ON rp.role_id = b.role_id
		JOIN permissions p ON p.id = rp.permission_id
		WHERE b.workspace_id = $1::uuid AND p.key = $2
	`, workspaceID, authz.PermWorkspaceAdminister).Scan(&n)
	if err != nil {
		return mapDBErr(err)
	}
	if n < 1 {
		return ErrLastAdmin
	}
	return nil
}

func mapDBErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrConflict
		case "23503":
			return ErrNotFound
		case "22P02":
			return ErrInvalid
		}
	}
	return err
}
