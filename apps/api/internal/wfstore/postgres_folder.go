package wfstore

import (
	"context"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const folderSelectSQL = `
SELECT id::text, workspace_id::text, parent_id::text, name, created_at, updated_at
FROM workflow_folders
`

func (p *Postgres) CreateFolder(ctx context.Context, scope isolation.Scope, in CreateFolderInput) (Folder, error) {
	if scope.Zero() {
		return Folder{}, ErrNoScope
	}
	name, err := NormalizeFolderName(in.Name)
	if err != nil {
		return Folder{}, err
	}
	parentID := strings.TrimSpace(in.ParentID)
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Folder{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var parentArg any
	if parentID != "" {
		if !authz.ValidUUID(parentID) {
			return Folder{}, ErrNotFound
		}
		if err := requireFolder(ctx, tx, parentID); err != nil {
			return Folder{}, err
		}
		depth, err := folderDepthTx(ctx, tx, parentID)
		if err != nil {
			return Folder{}, err
		}
		if depth >= MaxFolderDepth {
			return Folder{}, ErrFolderDepth
		}
		parentArg = parentID
	}

	folder, err := scanFolder(tx.QueryRow(ctx, `
		INSERT INTO workflow_folders (workspace_id, parent_id, name, created_by, updated_by)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $4::uuid)
		RETURNING id::text, workspace_id::text, parent_id::text, name, created_at, updated_at
	`, scope.WorkspaceID(), parentArg, name, actorArg(scope)))
	if err != nil {
		return Folder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Folder{}, mapDBErr(err)
	}
	return folder, nil
}

func (p *Postgres) ListFolders(ctx context.Context, scope isolation.Scope) ([]Folder, error) {
	items, _, err := p.ListFoldersPage(ctx, scope, page.Query{})
	return items, err
}

func (p *Postgres) ListFoldersPage(ctx context.Context, scope isolation.Scope, q page.Query) ([]Folder, string, error) {
	if scope.Zero() {
		return nil, "", ErrNoScope
	}
	if q.Bound && (q.Limit < 1 || q.Limit > page.MaxLimit) {
		return nil, "", page.ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, "", mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	args := []any{}
	sql := folderSelectSQL
	var parts []string
	if pred := page.SearchPredicate(&args, q.Q, "name"); pred != "" {
		parts = append(parts, pred)
	}
	order := ` ORDER BY lower(name), id`
	if q.Bound {
		keyset, err := page.AscTextPredicate(&args, page.ColFolder, "lower(name)", "id", q.Cursor)
		if err != nil {
			return nil, "", err
		}
		if keyset != "" {
			parts = append(parts, keyset)
		}
		order = ` ORDER BY lower(name), id` + page.LimitSQL(&args, q)
	}
	if len(parts) > 0 {
		sql += " WHERE " + strings.Join(parts, " AND ")
	}
	rows, err := tx.Query(ctx, sql+order, args...)
	if err != nil {
		return nil, "", mapDBErr(err)
	}
	defer rows.Close()
	var out []Folder
	for rows.Next() {
		folder, err := scanFolder(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, folder)
	}
	if err := rows.Err(); err != nil {
		return nil, "", mapDBErr(err)
	}
	next := ""
	if q.Bound {
		out, next, err = page.Trim(page.ColFolder, q, out, func(folder Folder) page.Key {
			return page.Key{K: strings.ToLower(folder.Name), ID: folder.ID}
		})
		if err != nil {
			return nil, "", err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", mapDBErr(err)
	}
	if out == nil {
		out = []Folder{}
	}
	return out, next, nil
}

func (p *Postgres) GetFolder(ctx context.Context, scope isolation.Scope, folderID string) (Folder, error) {
	if scope.Zero() {
		return Folder{}, ErrNoScope
	}
	if !authz.ValidUUID(folderID) {
		return Folder{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Folder{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	folder, err := scanFolder(tx.QueryRow(ctx, folderSelectSQL+` WHERE id = $1::uuid`, folderID))
	if err != nil {
		return Folder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Folder{}, mapDBErr(err)
	}
	return folder, nil
}

func (p *Postgres) UpdateFolder(ctx context.Context, scope isolation.Scope, folderID string, in UpdateFolderInput) (Folder, error) {
	if scope.Zero() {
		return Folder{}, ErrNoScope
	}
	if !authz.ValidUUID(folderID) {
		return Folder{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Folder{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	current, err := scanFolder(tx.QueryRow(ctx, folderSelectSQL+` WHERE id = $1::uuid`, folderID))
	if err != nil {
		return Folder{}, err
	}
	name := current.Name
	if in.Name != nil {
		normalized, err := NormalizeFolderName(*in.Name)
		if err != nil {
			return Folder{}, err
		}
		name = normalized
	}
	parentArg := any(nil)
	if current.ParentID != nil {
		parentArg = *current.ParentID
	}
	if in.ParentID != nil {
		next := strings.TrimSpace(*in.ParentID)
		if next == "" {
			parentArg = nil
		} else {
			if !authz.ValidUUID(next) {
				return Folder{}, ErrNotFound
			}
			if next == folderID {
				return Folder{}, ErrFolderCycle
			}
			if err := requireFolder(ctx, tx, next); err != nil {
				return Folder{}, err
			}
			cycle, err := folderWouldCycleTx(ctx, tx, next, folderID)
			if err != nil {
				return Folder{}, err
			}
			if cycle {
				return Folder{}, ErrFolderCycle
			}
			parentDepth, err := folderDepthTx(ctx, tx, next)
			if err != nil {
				return Folder{}, err
			}
			height, err := folderSubtreeHeightTx(ctx, tx, folderID)
			if err != nil {
				return Folder{}, err
			}
			if parentDepth+1+height-1 > MaxFolderDepth {
				return Folder{}, ErrFolderDepth
			}
			parentArg = next
		}
	}

	folder, err := scanFolder(tx.QueryRow(ctx, `
		UPDATE workflow_folders
		SET name = $2, parent_id = $3::uuid, updated_by = $4::uuid, updated_at = now()
		WHERE id = $1::uuid
		RETURNING id::text, workspace_id::text, parent_id::text, name, created_at, updated_at
	`, folderID, name, parentArg, actorArg(scope)))
	if err != nil {
		return Folder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Folder{}, mapDBErr(err)
	}
	return folder, nil
}

func (p *Postgres) DeleteFolder(ctx context.Context, scope isolation.Scope, folderID string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if !authz.ValidUUID(folderID) {
		return ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	if err := requireFolder(ctx, tx, folderID); err != nil {
		return err
	}
	var childFolders, workflows int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workflow_folders WHERE parent_id = $1::uuid`, folderID).Scan(&childFolders); err != nil {
		return mapDBErr(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workflows WHERE folder_id = $1::uuid`, folderID).Scan(&workflows); err != nil {
		return mapDBErr(err)
	}
	if childFolders > 0 || workflows > 0 {
		return FolderNotEmptyError{WorkflowCount: workflows, ChildFolderCount: childFolders}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM workflow_folders WHERE id = $1::uuid`, folderID)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return mapDBErr(err)
	}
	return nil
}

func (p *Postgres) SetWorkflowFolder(ctx context.Context, scope isolation.Scope, workflowID, folderID string) (Workflow, error) {
	if scope.Zero() {
		return Workflow{}, ErrNoScope
	}
	if !authz.ValidUUID(workflowID) {
		return Workflow{}, ErrNotFound
	}
	folderID = strings.TrimSpace(folderID)
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Workflow{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	if err := requireWorkflow(ctx, tx, workflowID); err != nil {
		return Workflow{}, err
	}
	var folderArg any
	if folderID != "" {
		if !authz.ValidUUID(folderID) {
			return Workflow{}, ErrNotFound
		}
		if err := requireFolder(ctx, tx, folderID); err != nil {
			return Workflow{}, err
		}
		folderArg = folderID
	}
	if _, err := tx.Exec(ctx, `UPDATE workflows SET folder_id = $2::uuid WHERE id = $1::uuid`, workflowID, folderArg); err != nil {
		return Workflow{}, mapDBErr(err)
	}
	wf, err := scanWorkflow(tx.QueryRow(ctx, getWorkflowSQL, workflowID))
	if err != nil {
		return Workflow{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workflow{}, mapDBErr(err)
	}
	return wf, nil
}

func requireFolder(ctx context.Context, tx pgx.Tx, folderID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM workflow_folders WHERE id = $1::uuid`, folderID).Scan(&id)
	if err != nil {
		return mapDBErr(err)
	}
	return nil
}

func folderDepthTx(ctx context.Context, tx pgx.Tx, folderID string) (int, error) {
	var depth int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE chain AS (
			SELECT id, parent_id, 1 AS depth
			FROM workflow_folders
			WHERE id = $1::uuid
			UNION ALL
			SELECT f.id, f.parent_id, c.depth + 1
			FROM workflow_folders f
			JOIN chain c ON f.id = c.parent_id
		)
		SELECT COALESCE(max(depth), 0) FROM chain
	`, folderID).Scan(&depth)
	if err != nil {
		return 0, mapDBErr(err)
	}
	return depth, nil
}

func folderSubtreeHeightTx(ctx context.Context, tx pgx.Tx, folderID string) (int, error) {
	var height int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE tree AS (
			SELECT id, 1 AS height
			FROM workflow_folders
			WHERE id = $1::uuid
			UNION ALL
			SELECT f.id, t.height + 1
			FROM workflow_folders f
			JOIN tree t ON f.parent_id = t.id
		)
		SELECT COALESCE(max(height), 0) FROM tree
	`, folderID).Scan(&height)
	if err != nil {
		return 0, mapDBErr(err)
	}
	return height, nil
}

func folderWouldCycleTx(ctx context.Context, tx pgx.Tx, startID, ancestorID string) (bool, error) {
	var found bool
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_id
			FROM workflow_folders
			WHERE id = $1::uuid
			UNION ALL
			SELECT f.id, f.parent_id
			FROM workflow_folders f
			JOIN ancestors a ON f.id = a.parent_id
		)
		SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2::uuid)
	`, startID, ancestorID).Scan(&found)
	if err != nil {
		return false, mapDBErr(err)
	}
	return found, nil
}

func scanFolder(row rowScanner) (Folder, error) {
	var f Folder
	if err := row.Scan(&f.ID, &f.WorkspaceID, &f.ParentID, &f.Name, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return Folder{}, mapDBErr(err)
	}
	return f, nil
}

func listWorkflowFolderClause(filter WorkflowListFilter) string {
	switch {
	case filter.Unfiled:
		return ` WHERE w.folder_id IS NULL ORDER BY w.updated_at DESC, w.slug`
	case strings.TrimSpace(filter.FolderID) != "":
		return ` WHERE w.folder_id = $1::uuid ORDER BY w.updated_at DESC, w.slug`
	default:
		return ` ORDER BY w.updated_at DESC, w.slug`
	}
}

func listWorkflowFolderArgs(filter WorkflowListFilter) []any {
	if filter.Unfiled || strings.TrimSpace(filter.FolderID) == "" {
		return nil
	}
	return []any{strings.TrimSpace(filter.FolderID)}
}
