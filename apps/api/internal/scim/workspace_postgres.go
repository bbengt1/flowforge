package scim

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// TxDB is the subset of pgx the workspace directory needs.
type TxDB interface {
	DB
	Begin(ctx context.Context) (pgx.Tx, error)
}

// WorkspacePostgres is the PostgreSQL WorkspaceDirectory. scim_tokens
// has no RLS and is read by hash on the SCIM door. Everything that
// touches scim_workspace_users, role bindings, group rows, or audit
// rows runs in a transaction scoped to the token's workspace.
type WorkspacePostgres struct {
	db TxDB
}

// NewWorkspacePostgres returns the PostgreSQL WorkspaceDirectory.
func NewWorkspacePostgres(db TxDB) *WorkspacePostgres {
	return &WorkspacePostgres{db: db}
}

// lastUsedEvery throttles last_used_at writes per token.
const lastUsedEvery = time.Minute

func (p *WorkspacePostgres) scoped(ctx context.Context, workspaceID string, fn func(pgx.Tx) error) error {
	tx, err := postgres.BeginScoped(ctx, p.db, workspaceID)
	if err != nil {
		return mapWorkspaceErr(err)
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return mapWorkspaceErr(tx.Commit(ctx))
}

// ---- tokens ----

func (p *WorkspacePostgres) CreateToken(ctx context.Context, workspaceID string, actor Actor, displayName string, now time.Time) (Token, string, error) {
	if !authz.ValidUUID(workspaceID) {
		return Token{}, "", ErrInvalid
	}
	name, err := NormalizeTokenName(displayName)
	if err != nil {
		return Token{}, "", err
	}
	plaintext, err := NewToken()
	if err != nil {
		return Token{}, "", ErrUnavailable
	}
	var tok Token
	err = p.scoped(ctx, workspaceID, func(tx pgx.Tx) error {
		// Serialize creates per workspace so two creates racing for the
		// last slot cannot both pick it. The partial unique index on
		// (workspace_id, slot) is the backstop.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('scim_tokens:' || $1, 0))`, workspaceID); err != nil {
			return mapWorkspaceErr(err)
		}
		rows, err := tx.Query(ctx, `
			SELECT slot FROM scim_tokens
			 WHERE workspace_id = $1::uuid AND revoked_at IS NULL`, workspaceID)
		if err != nil {
			return mapWorkspaceErr(err)
		}
		used := map[int16]bool{}
		for rows.Next() {
			var slot int16
			if err := rows.Scan(&slot); err != nil {
				rows.Close()
				return mapWorkspaceErr(err)
			}
			used[slot] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return mapWorkspaceErr(err)
		}
		var slot int16
		for s := int16(1); s <= MaxActiveTokens; s++ {
			if !used[s] {
				slot = s
				break
			}
		}
		if slot == 0 {
			return ErrTokenLimit
		}
		var createdBy any
		if authz.ValidUUID(actor.UserID) {
			createdBy = actor.UserID
		}
		err = tx.QueryRow(ctx, `
			INSERT INTO scim_tokens (workspace_id, display_name, token_hash, slot, created_by, created_at)
			VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
			RETURNING id::text, created_at`,
			workspaceID, name, HashToken(plaintext), slot, createdBy, now.UTC()).Scan(&tok.ID, &tok.CreatedAt)
		if err != nil {
			return mapTokenInsertErr(err)
		}
		tok.WorkspaceID = workspaceID
		tok.DisplayName = name
		if createdBy != nil {
			var dn string
			if err := tx.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1::uuid`, actor.UserID).Scan(&dn); err == nil {
				tok.CreatedBy = &TokenCreator{ID: actor.UserID, DisplayName: dn}
			}
		}
		return insertAudit(ctx, tx, workspaceID, actor, AuditTokenCreate, AuditResourceToken, tok.ID, map[string]any{"displayName": name})
	})
	if err != nil {
		return Token{}, "", err
	}
	return tok, plaintext, nil
}

func (p *WorkspacePostgres) ListTokens(ctx context.Context, workspaceID string) ([]Token, error) {
	if !authz.ValidUUID(workspaceID) {
		return nil, ErrInvalid
	}
	rows, err := p.db.Query(ctx, `
		SELECT t.id::text, t.workspace_id::text, t.display_name, t.created_at, t.last_used_at,
		       COALESCE(u.id::text, ''), COALESCE(u.display_name, '')
		  FROM scim_tokens t
		  LEFT JOIN users u ON u.id = t.created_by
		 WHERE t.workspace_id = $1::uuid AND t.revoked_at IS NULL
		 ORDER BY t.created_at DESC, t.id DESC`, workspaceID)
	if err != nil {
		return nil, mapWorkspaceErr(err)
	}
	defer rows.Close()
	out := []Token{}
	for rows.Next() {
		var t Token
		var creatorID, creatorName string
		if err := rows.Scan(&t.ID, &t.WorkspaceID, &t.DisplayName, &t.CreatedAt, &t.LastUsedAt, &creatorID, &creatorName); err != nil {
			return nil, mapWorkspaceErr(err)
		}
		if creatorID != "" {
			t.CreatedBy = &TokenCreator{ID: creatorID, DisplayName: creatorName}
		}
		out = append(out, t)
	}
	return out, mapWorkspaceErr(rows.Err())
}

func (p *WorkspacePostgres) RevokeToken(ctx context.Context, workspaceID, tokenID string, actor Actor, now time.Time) error {
	if !authz.ValidUUID(workspaceID) || !authz.ValidUUID(tokenID) {
		return ErrNotFound
	}
	return p.scoped(ctx, workspaceID, func(tx pgx.Tx) error {
		var name string
		err := tx.QueryRow(ctx, `
			UPDATE scim_tokens SET revoked_at = $3
			 WHERE id = $1::uuid AND workspace_id = $2::uuid AND revoked_at IS NULL
			RETURNING display_name`, tokenID, workspaceID, now.UTC()).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM scim_tokens WHERE id = $1::uuid AND workspace_id = $2::uuid)`,
				tokenID, workspaceID).Scan(&exists); err != nil {
				return mapWorkspaceErr(err)
			}
			if !exists {
				return ErrNotFound
			}
			return nil
		}
		if err != nil {
			return mapWorkspaceErr(err)
		}
		return insertAudit(ctx, tx, workspaceID, actor, AuditTokenRevoke, AuditResourceToken, tokenID, map[string]any{"displayName": name})
	})
}

func (p *WorkspacePostgres) Authenticate(ctx context.Context, presented string, now time.Time) (TokenScope, error) {
	if !WellFormedToken(presented) {
		return TokenScope{}, ErrUnauthorized
	}
	var scope TokenScope
	var revoked *time.Time
	var lastUsed *time.Time
	var wsStatus, tenantStatus string
	err := p.db.QueryRow(ctx, `
		SELECT t.id::text, t.workspace_id::text, w.tenant_id::text, t.revoked_at, t.last_used_at, w.status, tn.status
		  FROM scim_tokens t
		  JOIN workspaces w ON w.id = t.workspace_id
		  JOIN tenants tn ON tn.id = w.tenant_id
		 WHERE t.token_hash = $1`, HashToken(presented)).Scan(
		&scope.TokenID, &scope.WorkspaceID, &scope.TenantID, &revoked, &lastUsed, &wsStatus, &tenantStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return TokenScope{}, ErrUnauthorized
	}
	if err != nil {
		return TokenScope{}, ErrUnavailable
	}
	if revoked != nil || wsStatus != "active" || tenantStatus != "active" {
		return TokenScope{}, ErrUnauthorized
	}
	if lastUsed == nil || now.Sub(*lastUsed) >= lastUsedEvery {
		if _, err := p.db.Exec(ctx, `
			UPDATE scim_tokens SET last_used_at = $2::timestamptz
			 WHERE id = $1::uuid AND revoked_at IS NULL
			   AND (last_used_at IS NULL OR last_used_at <= $2::timestamptz - interval '1 minute')`,
			scope.TokenID, now.UTC()); err != nil {
			return TokenScope{}, ErrUnavailable
		}
	}
	return scope, nil
}

// ---- users ----

const wsUserColumns = `l.user_id::text, l.user_name, l.external_id, u.display_name, u.status, l.deactivated_at, l.created_at, l.updated_at`

func scanWorkspaceUser(row pgx.Row) (WorkspaceUser, error) {
	var u WorkspaceUser
	err := row.Scan(&u.UserID, &u.UserName, &u.ExternalID, &u.DisplayName, &u.Status, &u.DeactivatedAt, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

func (p *WorkspacePostgres) ListUsers(ctx context.Context, scope TokenScope, attr, value string, startIndex, count int) ([]WorkspaceUser, int, error) {
	where := ""
	args := []any{scope.WorkspaceID}
	switch attr {
	case "":
	case "userName":
		where = " AND lower(l.user_name) = lower($2)"
		args = append(args, value)
	case "externalId":
		where = " AND l.external_id = $2 AND l.external_id <> ''"
		args = append(args, value)
	case "id":
		if !authz.ValidUUID(value) {
			return nil, 0, nil
		}
		where = " AND l.user_id = $2::uuid"
		args = append(args, value)
	default:
		return nil, 0, ErrInvalid
	}
	if startIndex < 1 {
		startIndex = 1
	}
	var out []WorkspaceUser
	total := 0
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM scim_workspace_users l
			 WHERE l.workspace_id = $1::uuid`+where, args...).Scan(&total); err != nil {
			return mapWorkspaceErr(err)
		}
		if count <= 0 {
			return nil
		}
		pageArgs := append(append([]any{}, args...), count, startIndex-1)
		n := len(args)
		rows, err := tx.Query(ctx, `
			SELECT `+wsUserColumns+`
			  FROM scim_workspace_users l
			  JOIN users u ON u.id = l.user_id
			 WHERE l.workspace_id = $1::uuid`+where+`
			 ORDER BY l.created_at, l.user_id
			 LIMIT $`+strconv.Itoa(n+1)+` OFFSET $`+strconv.Itoa(n+2), pageArgs...)
		if err != nil {
			return mapWorkspaceErr(err)
		}
		defer rows.Close()
		for rows.Next() {
			u, err := scanWorkspaceUser(rows)
			if err != nil {
				return mapWorkspaceErr(err)
			}
			out = append(out, u)
		}
		return mapWorkspaceErr(rows.Err())
	})
	if err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

func (p *WorkspacePostgres) GetUser(ctx context.Context, scope TokenScope, userID string) (WorkspaceUser, error) {
	if !authz.ValidUUID(userID) {
		return WorkspaceUser{}, ErrNotFound
	}
	var out WorkspaceUser
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		u, err := getLinked(ctx, tx, scope.WorkspaceID, userID, false)
		out = u
		return err
	})
	return out, err
}

func getLinked(ctx context.Context, tx pgx.Tx, workspaceID, userID string, lock bool) (WorkspaceUser, error) {
	sql := `SELECT ` + wsUserColumns + `
		  FROM scim_workspace_users l
		  JOIN users u ON u.id = l.user_id
		 WHERE l.workspace_id = $1::uuid AND l.user_id = $2::uuid`
	if lock {
		sql += ` FOR UPDATE OF l`
	}
	u, err := scanWorkspaceUser(tx.QueryRow(ctx, sql, workspaceID, userID))
	if err != nil {
		return WorkspaceUser{}, mapWorkspaceErr(err)
	}
	return u, nil
}

func (p *WorkspacePostgres) ProvisionUser(ctx context.Context, scope TokenScope, in ProvisionInput, actor Actor, now time.Time) (WorkspaceUser, error) {
	in.UserName = strings.TrimSpace(in.UserName)
	in.ExternalID = strings.TrimSpace(in.ExternalID)
	if in.UserName == "" || len(in.UserName) > 256 || len(in.ExternalID) > 256 ||
		!authz.ValidIssuer(in.Issuer) || !authz.ValidSubject(in.Subject) || len(in.DisplayName) > 200 ||
		!authz.WorkspaceAssignableRole(in.DefaultRole) {
		return WorkspaceUser{}, ErrInvalid
	}
	var out WorkspaceUser
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		// Find or create the account. An existing account keeps its
		// display name and status: a workspace token never renames,
		// enables, or disables anyone.
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (issuer, external_subject, display_name)
			VALUES ($1, $2, $3)
			ON CONFLICT (issuer, external_subject) DO NOTHING`, in.Issuer, in.Subject, in.DisplayName); err != nil {
			return mapWorkspaceErr(err)
		}
		var userID string
		if err := tx.QueryRow(ctx, `
			SELECT id::text FROM users WHERE issuer = $1 AND external_subject = $2`, in.Issuer, in.Subject).Scan(&userID); err != nil {
			return mapWorkspaceErr(err)
		}
		var linked bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM scim_workspace_users WHERE workspace_id = $1::uuid AND user_id = $2::uuid)`,
			scope.WorkspaceID, userID).Scan(&linked); err != nil {
			return mapWorkspaceErr(err)
		}
		if linked {
			return ErrConflict
		}
		var deactivated any
		roleAdded := false
		if in.Active {
			added, err := addDefaultRoleIfNone(ctx, tx, scope.WorkspaceID, userID, in.DefaultRole)
			if err != nil {
				return err
			}
			roleAdded = added
		} else {
			if err := removeMembership(ctx, tx, scope.WorkspaceID, userID); err != nil {
				return err
			}
			deactivated = now.UTC()
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO scim_workspace_users (workspace_id, user_id, user_name, external_id, deactivated_at, created_at, updated_at)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $6)`,
			scope.WorkspaceID, userID, in.UserName, in.ExternalID, deactivated, now.UTC()); err != nil {
			return mapWorkspaceErr(err)
		}
		if err := insertAudit(ctx, tx, scope.WorkspaceID, actor, AuditUserWorkspaceAdd, AuditResourceUser, userID, map[string]any{
			"roleAdded":   roleAdded,
			"deactivated": !in.Active,
		}); err != nil {
			return err
		}
		u, err := getLinked(ctx, tx, scope.WorkspaceID, userID, false)
		out = u
		return err
	})
	return out, err
}

func (p *WorkspacePostgres) UpdateUser(ctx context.Context, scope TokenScope, userID string, ch UserChange, defaultRole string, actor Actor, now time.Time) (WorkspaceUser, error) {
	if !authz.ValidUUID(userID) {
		return WorkspaceUser{}, ErrNotFound
	}
	var out WorkspaceUser
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		cur, err := getLinked(ctx, tx, scope.WorkspaceID, userID, true)
		if err != nil {
			return err
		}
		var ignored []string
		if ch.UserName != nil && strings.TrimSpace(*ch.UserName) != cur.UserName {
			ignored = append(ignored, "userName")
		}
		if ch.ExternalID != nil && strings.TrimSpace(*ch.ExternalID) != cur.ExternalID {
			ignored = append(ignored, "externalId")
		}
		if ch.DisplayName != nil && strings.TrimSpace(*ch.DisplayName) != cur.DisplayName {
			ignored = append(ignored, "displayName")
		}
		if ch.Active != nil {
			switch {
			case !*ch.Active && cur.DeactivatedAt == nil:
				if err := removeMembership(ctx, tx, scope.WorkspaceID, userID); err != nil {
					return err
				}
				if err := setDeactivated(ctx, tx, scope.WorkspaceID, userID, now.UTC()); err != nil {
					return err
				}
				if err := insertAudit(ctx, tx, scope.WorkspaceID, actor, AuditUserDeactivate, AuditResourceUser, userID, map[string]any{}); err != nil {
					return err
				}
			case *ch.Active && cur.DeactivatedAt != nil:
				added, err := addDefaultRoleIfNone(ctx, tx, scope.WorkspaceID, userID, defaultRole)
				if err != nil {
					return err
				}
				if err := setDeactivated(ctx, tx, scope.WorkspaceID, userID, nil); err != nil {
					return err
				}
				if err := insertAudit(ctx, tx, scope.WorkspaceID, actor, AuditUserReactivate, AuditResourceUser, userID, map[string]any{"roleAdded": added}); err != nil {
					return err
				}
			}
			// The global part of active:true is never applied.
			if *ch.Active && cur.Status != "active" {
				ignored = append(ignored, "active")
			}
		}
		if len(ignored) > 0 {
			if err := insertAudit(ctx, tx, scope.WorkspaceID, actor, AuditUserChangeIgnored, AuditResourceUser, userID, map[string]any{"attributes": ignored}); err != nil {
				return err
			}
		}
		u, err := getLinked(ctx, tx, scope.WorkspaceID, userID, false)
		out = u
		return err
	})
	return out, err
}

func (p *WorkspacePostgres) RemoveUser(ctx context.Context, scope TokenScope, userID string, actor Actor) error {
	if !authz.ValidUUID(userID) {
		return ErrNotFound
	}
	return p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		if _, err := getLinked(ctx, tx, scope.WorkspaceID, userID, true); err != nil {
			return err
		}
		if err := removeMembership(ctx, tx, scope.WorkspaceID, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM scim_workspace_users WHERE workspace_id = $1::uuid AND user_id = $2::uuid`,
			scope.WorkspaceID, userID); err != nil {
			return mapWorkspaceErr(err)
		}
		return insertAudit(ctx, tx, scope.WorkspaceID, actor, AuditUserWorkspaceRemove, AuditResourceUser, userID, map[string]any{})
	})
}

// ---- group ----

func (p *WorkspacePostgres) GetGroup(ctx context.Context, scope TokenScope) (WorkspaceGroup, error) {
	var out WorkspaceGroup
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		g, err := loadGroup(ctx, tx, scope.WorkspaceID)
		out = g
		return err
	})
	return out, err
}

func loadGroup(ctx context.Context, tx pgx.Tx, workspaceID string) (WorkspaceGroup, error) {
	g := WorkspaceGroup{ID: workspaceID}
	if err := tx.QueryRow(ctx, `SELECT name, workbench_key FROM workspaces WHERE id = $1::uuid`, workspaceID).Scan(&g.Name, &g.WorkbenchKey); err != nil {
		return WorkspaceGroup{}, mapWorkspaceErr(err)
	}
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.display_name
		  FROM scim_workspace_users l
		  JOIN users u ON u.id = l.user_id
		 WHERE l.workspace_id = $1::uuid AND l.deactivated_at IS NULL
		   AND EXISTS (SELECT 1 FROM workspace_role_bindings b
		                WHERE b.workspace_id = l.workspace_id AND b.user_id = l.user_id)
		 ORDER BY lower(u.display_name), u.id`, workspaceID)
	if err != nil {
		return WorkspaceGroup{}, mapWorkspaceErr(err)
	}
	defer rows.Close()
	g.Members = []GroupMember{}
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.UserID, &m.DisplayName); err != nil {
			return WorkspaceGroup{}, mapWorkspaceErr(err)
		}
		g.Members = append(g.Members, m)
	}
	return g, mapWorkspaceErr(rows.Err())
}

func (p *WorkspacePostgres) PatchGroup(ctx context.Context, scope TokenScope, ch GroupChange, defaultRole string, actor Actor, now time.Time) (WorkspaceGroup, error) {
	var out WorkspaceGroup
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		for _, id := range ch.Add {
			if !authz.ValidUUID(id) {
				return ErrInvalid
			}
			cur, err := getLinked(ctx, tx, scope.WorkspaceID, id, true)
			if errors.Is(err, ErrNotFound) {
				// Only users this workspace's IdP linked can be added.
				return ErrInvalid
			}
			if err != nil {
				return err
			}
			added, err := addDefaultRoleIfNone(ctx, tx, scope.WorkspaceID, id, defaultRole)
			if err != nil {
				return err
			}
			if cur.DeactivatedAt != nil {
				if err := setDeactivated(ctx, tx, scope.WorkspaceID, id, nil); err != nil {
					return err
				}
			}
			if cur.DeactivatedAt != nil || added {
				if err := insertAudit(ctx, tx, scope.WorkspaceID, actor, AuditUserReactivate, AuditResourceUser, id, map[string]any{"roleAdded": added, "via": "group"}); err != nil {
					return err
				}
			}
		}
		for _, id := range ch.Remove {
			if !authz.ValidUUID(id) {
				continue
			}
			cur, err := getLinked(ctx, tx, scope.WorkspaceID, id, true)
			if errors.Is(err, ErrNotFound) {
				// Not linked here: invisible to this token, never removed.
				continue
			}
			if err != nil {
				return err
			}
			if cur.DeactivatedAt != nil {
				continue
			}
			if err := removeMembership(ctx, tx, scope.WorkspaceID, id); err != nil {
				return err
			}
			if err := setDeactivated(ctx, tx, scope.WorkspaceID, id, now.UTC()); err != nil {
				return err
			}
			if err := insertAudit(ctx, tx, scope.WorkspaceID, actor, AuditUserDeactivate, AuditResourceUser, id, map[string]any{"via": "group"}); err != nil {
				return err
			}
		}
		g, err := loadGroup(ctx, tx, scope.WorkspaceID)
		out = g
		return err
	})
	return out, err
}

// ---- helpers ----

func setDeactivated(ctx context.Context, tx pgx.Tx, workspaceID, userID string, at any) error {
	_, err := tx.Exec(ctx, `
		UPDATE scim_workspace_users SET deactivated_at = $3, updated_at = now()
		 WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, workspaceID, userID, at)
	return mapWorkspaceErr(err)
}

// addDefaultRoleIfNone grants role only when the user holds no role in
// the workspace. Existing roles are never changed.
func addDefaultRoleIfNone(ctx context.Context, tx pgx.Tx, workspaceID, userID, role string) (bool, error) {
	if !authz.WorkspaceAssignableRole(role) {
		return false, ErrInvalid
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO workspace_role_bindings (workspace_id, user_id, role_id)
		SELECT $1::uuid, $2::uuid, r.id FROM roles r
		 WHERE r.key = $3
		   AND NOT EXISTS (SELECT 1 FROM workspace_role_bindings b
		                    WHERE b.workspace_id = $1::uuid AND b.user_id = $2::uuid)`,
		workspaceID, userID, role)
	if err != nil {
		return false, mapWorkspaceErr(err)
	}
	return tag.RowsAffected() > 0, nil
}

// removeMembership deletes the user's role bindings and group rows in
// this workspace inside the caller's scoped transaction. Lock order is
// bindings first, then group rows, the same as identity.RemoveMember.
// Removing the last administrator is ErrLastAdmin and the caller's
// transaction rolls back.
func removeMembership(ctx context.Context, tx pgx.Tx, workspaceID, userID string) error {
	tag, err := tx.Exec(ctx, `
		DELETE FROM workspace_role_bindings WHERE workspace_id = $1::uuid AND user_id = $2::uuid`,
		workspaceID, userID)
	if err != nil {
		return mapWorkspaceErr(err)
	}
	if tag.RowsAffected() > 0 {
		var n int
		if err := tx.QueryRow(ctx, `
			SELECT COUNT(DISTINCT b.user_id)
			  FROM workspace_role_bindings b
			  JOIN role_permissions rp ON rp.role_id = b.role_id
			  JOIN permissions p ON p.id = rp.permission_id
			 WHERE b.workspace_id = $1::uuid AND p.key = $2`,
			workspaceID, authz.PermWorkspaceAdminister).Scan(&n); err != nil {
			return mapWorkspaceErr(err)
		}
		if n < 1 {
			return ErrLastAdmin
		}
	}
	_, err = tx.Exec(ctx, `
		DELETE FROM workspace_group_members WHERE workspace_id = $1::uuid AND user_id = $2::uuid`,
		workspaceID, userID)
	return mapWorkspaceErr(err)
}

// insertAudit writes one workspace audit row in the caller's scoped
// transaction. Details never carry a token: a value shaped like one is
// refused rather than written.
func insertAudit(ctx context.Context, tx pgx.Tx, workspaceID string, actor Actor, action, resourceType, resourceID string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	if actor.TokenID != "" {
		details["tokenId"] = actor.TokenID
		details["via"] = "scim_token"
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return ErrInvalid
	}
	if ContainsToken(string(raw)) {
		return ErrInvalid
	}
	host := map[string]string{}
	rid := strings.TrimSpace(actor.RequestID)
	if len(rid) > 128 {
		rid = ""
	}
	if rid != "" {
		host["requestId"] = rid
	}
	hostRaw, err := json.Marshal(host)
	if err != nil {
		return ErrInvalid
	}
	var actorID any
	if authz.ValidUUID(actor.UserID) {
		actorID = actor.UserID
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events (
			workspace_id, actor_id, host_context_redacted, action, resource_type,
			resource_id, outcome, correlation_id, details_redacted
		) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6::uuid, 'success', NULLIF($7, ''), $8::jsonb)`,
		workspaceID, actorID, hostRaw, action, resourceType, resourceID, rid, raw)
	return mapWorkspaceErr(err)
}

func mapTokenInsertErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "scim_tokens_active_slot_uidx" {
		return ErrTokenLimit
	}
	return mapWorkspaceErr(err)
}

func mapWorkspaceErr(err error) error {
	if err == nil {
		return nil
	}
	for _, known := range []error{ErrNotFound, ErrConflict, ErrInvalid, ErrUnauthorized, ErrTokenLimit, ErrLastAdmin, ErrUnavailable} {
		if errors.Is(err, known) {
			return err
		}
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
		case "22P02", "23514":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}
