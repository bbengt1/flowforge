package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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
    applied_at  timestamptz NOT NULL DEFAULT now(),
    checksum    text
);
`

// ensureSchemaMigrationsChecksum adds the checksum column on databases
// created before G.3.5. CREATE TABLE IF NOT EXISTS does not alter an
// existing table.
const ensureSchemaMigrationsChecksum = `
ALTER TABLE schema_migrations
    ADD COLUMN IF NOT EXISTS checksum text;
`

// ErrMigrationDrift means an applied migration file does not match the
// checksum recorded in schema_migrations (or the file is missing / renamed).
// Boot must stop. Retrying will not succeed until the file is restored.
var ErrMigrationDrift = errors.New("migration checksum drift")

const migrationRunbook = "docs/operations/schema-migrations.md#refused-boot"

// migrationLockKey is a session-level advisory lock that serializes
// forward-only schema application across API replicas and cmd/migrate.
// See docs/reference/database.md (migration serialization).
const migrationLockKey int64 = 881726401

type migration struct {
	Version  int64
	Name     string
	SQL      string
	Checksum string
}

type appliedMigration struct {
	Name     string
	Checksum string
}

type driftReason string

const (
	driftChecksum driftReason = "checksum"
	driftMissing  driftReason = "missing"
	driftName     driftReason = "name"
)

// migrationDriftError is the operator-facing boot refusal. It names the
// migration and the next action. It does not include SQL or secrets.
type migrationDriftError struct {
	Version  int64
	Name     string
	File     string
	Recorded string
	Actual   string
	Reason   driftReason
}

func (e *migrationDriftError) Error() string {
	if e == nil {
		return "refusing boot: migration checksum drift. See " + migrationRunbook
	}
	switch e.Reason {
	case driftMissing:
		return fmt.Sprintf(
			"refusing boot: applied migration version %d (%s) has no file in this binary. Restore %s from the release that applied it and restart. See %s",
			e.Version, e.Name, e.File, migrationRunbook,
		)
	case driftName:
		return fmt.Sprintf(
			"refusing boot: schema_migrations version %d is recorded as %q but the migration file in this binary is %q (%s). Restore the applied migration file and restart. See %s",
			e.Version, e.Name, e.Actual, e.File, migrationRunbook,
		)
	default:
		return fmt.Sprintf(
			"refusing boot: migration checksum drift for version %d (%s, file %s): recorded sha256 %s does not match the migration file in this binary (sha256 %s). Restore that file from the release that applied it (do not edit applied SQL or schema_migrations) and restart. See %s",
			e.Version, e.Name, e.File, e.Recorded, e.Actual, migrationRunbook,
		)
	}
}

func (e *migrationDriftError) Unwrap() error { return ErrMigrationDrift }

// Migrate applies pending forward-only SQL files and records them in
// schema_migrations. Re-running is a no-op for already-applied versions.
// Each applied file's SHA-256 is stored and checked against the bytes on
// disk before any new migration runs. Drift refuses boot (ErrMigrationDrift).
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
	if _, err := conn.Exec(ctx, ensureSchemaMigrationsChecksum); err != nil {
		return fmt.Errorf("ensure schema_migrations checksum: %w", err)
	}

	all, err := loadMigrations()
	if err != nil {
		return err
	}

	applied, err := appliedVersions(ctx, conn)
	if err != nil {
		return err
	}
	if err := verifyAppliedChecksums(all, applied); err != nil {
		return err
	}
	if err := stampMissingChecksums(ctx, conn, all, applied); err != nil {
		return err
	}

	pending, err := pendingMigrations(all, appliedNames(applied))
	if err != nil {
		return err
	}
	for _, m := range pending {
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
		out = append(out, migration{
			Version:  version,
			Name:     name,
			SQL:      string(body),
			Checksum: checksumBytes(body),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Version != out[j].Version {
			return out[i].Version < out[j].Version
		}
		return out[i].Name < out[j].Name
	})
	for i := 1; i < len(out); i++ {
		if out[i].Version == out[i-1].Version {
			return nil, fmt.Errorf("duplicate migration version %d (%s and %s)", out[i].Version, out[i-1].Name, out[i].Name)
		}
	}
	return out, nil
}

// pendingMigrations returns files whose version is not yet recorded.
// A recorded version whose name does not match the file fails closed so a
// collided version cannot silently skip a different migration.
func pendingMigrations(all []migration, applied map[int64]string) ([]migration, error) {
	pending := make([]migration, 0, len(all))
	for _, m := range all {
		name, ok := applied[m.Version]
		if !ok {
			pending = append(pending, m)
			continue
		}
		if name != m.Name {
			return nil, &migrationDriftError{
				Version: m.Version,
				Name:    name,
				File:    migrationFilename(m.Version, m.Name),
				Actual:  m.Name,
				Reason:  driftName,
			}
		}
	}
	return pending, nil
}

func checksumBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func migrationFilename(version int64, name string) string {
	return fmt.Sprintf("%06d_%s.sql", version, name)
}

// verifyAppliedChecksums compares recorded checksums to the files on disk.
// An empty checksum is the pre-G.3.5 row and is not drift; the caller stamps
// it from the current file. A mismatch, a missing file, or a renamed file
// refuses boot.
func verifyAppliedChecksums(all []migration, applied map[int64]appliedMigration) error {
	byVersion := make(map[int64]migration, len(all))
	for _, m := range all {
		byVersion[m.Version] = m
	}
	versions := make([]int64, 0, len(applied))
	for version := range applied {
		versions = append(versions, version)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for _, version := range versions {
		row := applied[version]
		file, ok := byVersion[version]
		if !ok {
			return &migrationDriftError{
				Version: version,
				Name:    row.Name,
				File:    migrationFilename(version, row.Name),
				Reason:  driftMissing,
			}
		}
		if row.Name != file.Name {
			return &migrationDriftError{
				Version: version,
				Name:    row.Name,
				File:    migrationFilename(version, file.Name),
				Actual:  file.Name,
				Reason:  driftName,
			}
		}
		if row.Checksum == "" {
			continue
		}
		if row.Checksum != file.Checksum {
			return &migrationDriftError{
				Version:  version,
				Name:     file.Name,
				File:     migrationFilename(version, file.Name),
				Recorded: row.Checksum,
				Actual:   file.Checksum,
				Reason:   driftChecksum,
			}
		}
	}
	return nil
}

func appliedNames(applied map[int64]appliedMigration) map[int64]string {
	names := make(map[int64]string, len(applied))
	for version, row := range applied {
		names[version] = row.Name
	}
	return names
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

func appliedVersions(ctx context.Context, conn *pgxpool.Conn) (map[int64]appliedMigration, error) {
	rows, err := conn.Query(ctx, `SELECT version, name, checksum FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("list schema_migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[int64]appliedMigration)
	for rows.Next() {
		var version int64
		var name string
		var checksum *string
		if err := rows.Scan(&version, &name, &checksum); err != nil {
			return nil, fmt.Errorf("scan schema_migrations: %w", err)
		}
		row := appliedMigration{Name: name}
		if checksum != nil {
			row.Checksum = *checksum
		}
		applied[version] = row
	}
	return applied, rows.Err()
}

// stampMissingChecksums records the on-disk SHA-256 for rows applied before
// checksums existed. It never overwrites a recorded checksum.
func stampMissingChecksums(ctx context.Context, conn *pgxpool.Conn, all []migration, applied map[int64]appliedMigration) error {
	var pending []migration
	for _, m := range all {
		row, ok := applied[m.Version]
		if !ok || row.Checksum != "" || row.Name != m.Name {
			continue
		}
		pending = append(pending, m)
	}
	if len(pending) == 0 {
		return nil
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration checksum stamp: %w", err)
	}
	defer tx.Rollback(ctx)
	for _, m := range pending {
		tag, err := tx.Exec(ctx,
			`UPDATE schema_migrations
			 SET checksum = $2
			 WHERE version = $1 AND (checksum IS NULL OR checksum = '')`,
			m.Version, m.Checksum,
		)
		if err != nil {
			return fmt.Errorf("record checksum for migration %d (%s): %w", m.Version, m.Name, err)
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("record checksum for migration %d (%s): expected to stamp 1 row", m.Version, m.Name)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration checksums: %w", err)
	}
	return nil
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
	if m.Checksum == "" {
		return fmt.Errorf("migration %d (%s) has no checksum", m.Version, m.Name)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
		m.Version, m.Name, m.Checksum,
	); err != nil {
		return fmt.Errorf("record migration %d: %w", m.Version, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %d: %w", m.Version, err)
	}
	return nil
}
