package postgres

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

const createSchemaMigrations = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     bigint PRIMARY KEY,
    name        text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);
`

// migrationLockKey is a session-level advisory lock that serializes
// forward-only schema application across API replicas and cmd/migrate.
// See docs/reference/database.md (migration serialization).
const migrationLockKey int64 = 881726401

type migration struct {
	Version int64
	Name    string
	SQL     string
}

// Migrate applies pending forward-only SQL files and records them in
// schema_migrations. Re-running is a no-op for already-applied versions.
// Discovery and application run under pg_advisory_lock on one connection.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return fmt.Errorf("postgres pool is nil")
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer unlockMigrations(conn)

	if _, err := conn.Exec(ctx, createSchemaMigrations); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	all, err := loadMigrations()
	if err != nil {
		return err
	}

	applied, err := appliedVersions(ctx, conn)
	if err != nil {
		return err
	}

	for _, m := range all {
		if applied[m.Version] {
			continue
		}
		if err := applyMigration(ctx, conn, m); err != nil {
			return err
		}
	}
	if err := ensureAppRole(ctx, conn); err != nil {
		return err
	}
	return nil
}

func unlockMigrations(conn *pgxpool.Conn) {
	unlockCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = conn.Exec(unlockCtx, `SELECT pg_advisory_unlock($1)`, migrationLockKey)
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrations.SQL, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}
	out := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version, name, err := parseMigrationName(entry.Name())
		if err != nil {
			return nil, err
		}
		body, err := fs.ReadFile(migrations.SQL, entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", entry.Name(), err)
		}
		out = append(out, migration{Version: version, Name: name, SQL: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

func parseMigrationName(filename string) (int64, string, error) {
	base := strings.TrimSuffix(filename, ".sql")
	versionStr, rest, ok := strings.Cut(base, "_")
	if !ok {
		return 0, "", fmt.Errorf("migration %q must be named NNNNNN_description.sql", filename)
	}
	version, err := strconv.ParseInt(versionStr, 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("migration %q version: %w", filename, err)
	}
	return version, rest, nil
}

func appliedVersions(ctx context.Context, conn *pgxpool.Conn) (map[int64]bool, error) {
	rows, err := conn.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("list schema_migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[int64]bool)
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			return nil, fmt.Errorf("scan schema_migrations: %w", err)
		}
		applied[version] = true
	}
	return applied, rows.Err()
}

func applyMigration(ctx context.Context, conn *pgxpool.Conn, m migration) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration %d: %w", m.Version, err)
	}
	defer tx.Rollback(ctx)

	if strings.TrimSpace(m.SQL) != "" {
		if _, err := tx.Exec(ctx, m.SQL); err != nil {
			return fmt.Errorf("apply migration %d (%s): %w", m.Version, m.Name, err)
		}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
		m.Version, m.Name,
	); err != nil {
		return fmt.Errorf("record migration %d: %w", m.Version, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %d: %w", m.Version, err)
	}
	return nil
}
