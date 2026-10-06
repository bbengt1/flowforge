// Command slug-backfill writes the stored workflow slug into metadata.slug
// of drafts where the two differ (#557). It runs for one workspace per
// call and is safe to re-run: a second run changes 0 drafts.
//
// The workspace comes from FLOWFORGE_WORKSPACE_ID. That value is used only
// to set the session setting app.workspace_id. The connection assumes the
// request role flowforge_app (NOSUPERUSER, NOBYPASSRLS), so FORCE RLS
// scopes every read and write. No query takes a workspace argument, and
// the command refuses to run when the session role can bypass RLS. It
// takes no flags. Output is counts only, never YAML.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/config"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// EnvWorkspaceID names the workspace whose session scope is set.
const EnvWorkspaceID = "FLOWFORGE_WORKSPACE_ID"

var errUsage = errors.New("usage: FLOWFORGE_WORKSPACE_ID=<workspace uuid> slug-backfill (no arguments)")

func main() {
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()

	if len(os.Args) > 1 {
		log.Error("slug-backfill", "error", errUsage)
		os.Exit(2)
	}
	// Only the database is needed. config.Load would also demand the API
	// signing secrets, which this command never uses.
	if err := run(ctx, config.DatabaseURL(), os.Getenv(EnvWorkspaceID), os.Stdout); err != nil {
		log.Error("slug-backfill", "error", err)
		os.Exit(1)
	}
}

// run backfills one workspace and prints the counts.
func run(ctx context.Context, databaseURL, workspaceID string, stdout io.Writer) error {
	if strings.TrimSpace(databaseURL) == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	scope, err := isolation.Authorize(strings.TrimSpace(workspaceID), "")
	if err != nil {
		return fmt.Errorf("%s must be a workspace UUID: %w", EnvWorkspaceID, errUsage)
	}
	// postgres.Open applies pending migrations as the login role, then
	// returns a pool whose connections SET ROLE flowforge_app.
	pool, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	res, err := wfstore.NewPostgres(pool).BackfillDraftSlugs(ctx, scope)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "workspace=%s\nscanned=%d\nchanged=%d\nskipped=%d\n", scope.WorkspaceID(), res.Scanned, res.Changed, res.Skipped)
	return err
}
