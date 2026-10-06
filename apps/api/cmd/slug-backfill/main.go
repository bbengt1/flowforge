// Command slug-backfill writes the stored workflow slug into metadata.slug
// of drafts where the two differ (#557). It runs for one workspace per
// call and is safe to re-run: a second run changes 0 drafts.
//
// The workspace comes from FLOWFORGE_WORKSPACE_ID. That value is used only
// to set the session setting app.workspace_id. The connection assumes the
// request role flowforge_app (NOSUPERUSER, NOBYPASSRLS), so FORCE RLS
// scopes every read and write. No query takes a workspace argument, and
// the command refuses to run when the session role can bypass RLS. It
// takes no flags.
//
// stdout gets the counts. stderr gets one structured JSON log line per
// rewritten draft (workspace id, workflow id, old and new slug) through
// the redacting slog handler. Unchanged drafts are not logged. YAML bodies
// and connection strings are never logged.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

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
	if err := run(ctx, config.DatabaseURL(), os.Getenv(EnvWorkspaceID), os.Stdout, log); err != nil {
		log.Error("slug-backfill", "error", err)
		os.Exit(1)
	}
}

// maxLoggedSlugRunes caps a logged slug. A stored slug is at most 63.
const maxLoggedSlugRunes = 128

// logSafe makes a value from user YAML safe for one log line. Printable
// ASCII passes through. Control characters, line and paragraph
// separators, and other non-ASCII runes become Go escapes (\n, \u2028),
// so the value cannot start a new line or forge a field even under a text
// handler. The JSON handler escapes again on output. Long values are cut.
func logSafe(s string) string {
	if utf8.RuneCountInString(s) > maxLoggedSlugRunes {
		s = string([]rune(s)[:maxLoggedSlugRunes]) + "..."
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e || s[i] == '"' || s[i] == '\\' {
			q := strconv.QuoteToASCII(s)
			return q[1 : len(q)-1]
		}
	}
	return s
}

// logChange writes the per-draft line. old_slug is empty and
// old_slug_missing is true when the draft had no metadata.slug.
func logChange(log *slog.Logger, workspaceID string, c wfstore.DraftSlugChange) {
	log.Info("slug-backfill draft changed",
		slog.String("workspace_id", workspaceID),
		slog.String("workflow_id", logSafe(c.WorkflowID)),
		slog.String("old_slug", logSafe(c.OldSlug)),
		slog.Bool("old_slug_missing", c.OldSlug == ""),
		slog.String("new_slug", logSafe(c.NewSlug)),
	)
}

// run backfills one workspace, logs each rewritten draft, and prints the
// counts.
func run(ctx context.Context, databaseURL, workspaceID string, stdout io.Writer, log *slog.Logger) error {
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
	if log != nil {
		for _, c := range res.Changes {
			logChange(log, scope.WorkspaceID(), c)
		}
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "workspace=%s\nscanned=%d\nchanged=%d\nskipped=%d\n", scope.WorkspaceID(), res.Scanned, res.Changed, res.Skipped)
	return err
}
