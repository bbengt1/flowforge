package identity

import (
	"context"
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
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
	rows, err := p.db.Query(ctx, `
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
		)
		ORDER BY w.created_at
	`, userID)
	if err != nil {
		return nil, mapDBErr(err)
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
			return nil, mapDBErr(err)
		}
		m.Permissions = authz.ExpandWorkspaceRoles(m.Roles)
		out = append(out, m)
	}
	return out, rows.Err()
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
	if _, err := p.GetWorkspace(ctx, workspaceID); err != nil {
		return nil, err
	}
	rows, err := p.db.Query(ctx, `
		SELECT u.id::text, u.issuer, u.external_subject, u.display_name, u.status, u.created_at, u.updated_at,
		       ARRAY(SELECT r.key FROM workspace_role_bindings b2
		             JOIN roles r ON r.id = b2.role_id
		             WHERE b2.workspace_id = $1::uuid AND b2.user_id = u.id
		             ORDER BY r.key)
		FROM users u
		WHERE EXISTS (
		    SELECT 1 FROM workspace_role_bindings b
		    WHERE b.workspace_id = $1::uuid AND b.user_id = u.id
		)
		ORDER BY u.created_at
	`, workspaceID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(
			&m.User.ID, &m.User.Issuer, &m.User.ExternalSubject, &m.User.DisplayName,
			&m.User.Status, &m.User.CreatedAt, &m.User.UpdatedAt, &m.Roles,
		); err != nil {
			return nil, mapDBErr(err)
		}
		m.Permissions = authz.ExpandWorkspaceRoles(m.Roles)
		out = append(out, m)
	}
	return out, rows.Err()
}

func (p *Postgres) SetMemberRoles(ctx context.Context, workspaceID, userID string, roleKeys []string) error {
	if err := validateRoleKeys(roleKeys); err != nil {
		return err
	}
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	if err := mustExist(ctx, tx, `SELECT 1 FROM workspaces WHERE id = $1::uuid`, workspaceID); err != nil {
		return err
	}
	if err := mustExist(ctx, tx, `SELECT 1 FROM users WHERE id = $1::uuid`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid
	`, workspaceID, userID); err != nil {
		return mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_role_bindings (workspace_id, user_id, role_id)
		SELECT $1::uuid, $2::uuid, r.id FROM roles r WHERE r.key = ANY($3::text[])
	`, workspaceID, userID, uniqueSorted(roleKeys)); err != nil {
		return mapDBErr(err)
	}
	if err := ensureAdmin(ctx, tx, workspaceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *Postgres) RemoveMember(ctx context.Context, workspaceID, userID string) error {
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid
	`, workspaceID, userID)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := ensureAdmin(ctx, tx, workspaceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
