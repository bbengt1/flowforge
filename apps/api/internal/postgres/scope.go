package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/jackc/pgx/v5"
)

// AppRole is the non-superuser, no-BYPASSRLS role used for request queries.
const AppRole = "flowforge_app"

// ErrNoWorkspaceScope is returned when a scoped transaction is requested
// without a server-derived workspace UUID.
var ErrNoWorkspaceScope = errors.New("workspace scope is not set")

// TxBeginner starts a PostgreSQL transaction.
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// BeginScoped starts a transaction and sets transaction-local app.workspace_id.
// Callers must authorize membership before invoking this.
func BeginScoped(ctx context.Context, db TxBeginner, workspaceID string) (pgx.Tx, error) {
	if !authz.ValidUUID(workspaceID) {
		return nil, ErrNoWorkspaceScope
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT app.set_workspace_id($1::uuid)`, workspaceID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("set workspace scope: %w", err)
	}
	return tx, nil
}
