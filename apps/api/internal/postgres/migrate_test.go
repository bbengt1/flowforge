package postgres

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestParseMigrationName(t *testing.T) {
	version, name, err := parseMigrationName("000001_foundation.sql")
	if err != nil {
		t.Fatal(err)
	}
	if version != 1 || name != "foundation" {
		t.Fatalf("got version=%d name=%q", version, name)
	}
}

func TestParseMigrationNameRejectsInvalid(t *testing.T) {
	if _, _, err := parseMigrationName("foundation.sql"); err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadMigrationsIncludesFoundation(t *testing.T) {
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) == 0 {
		t.Fatal("expected at least the foundation migration")
	}
	if all[0].Version != 1 {
		t.Fatalf("first migration version = %d, want 1", all[0].Version)
	}
	var sawIsolation, sawSessions, sawWorkflows, sawCredentials, sawOps, sawApprovals, sawExecutions, sawArtifacts, sawAuditIntegrity, sawKubernetesRead, sawEmbedValidation, sawPlatformAdmin, sawWorkspaceSessionRevoke, sawWorkflowFolders bool
	for _, m := range all {
		if m.Version == 3 && m.Name == "workspace_isolation" {
			sawIsolation = true
		}
		if m.Version == 4 && m.Name == "browser_sessions" {
			sawSessions = true
		}
		if m.Version == 5 && m.Name == "workflows" {
			sawWorkflows = true
		}
		if m.Version == 6 && m.Name == "credentials" {
			sawCredentials = true
		}
		if m.Version == 7 && m.Name == "ops_config" {
			sawOps = true
		}
		if m.Version == 8 && m.Name == "approvals" {
			sawApprovals = true
		}
		if m.Version == 9 && m.Name == "executions" {
			sawExecutions = true
		}
		if m.Version == 10 && m.Name == "execution_artifacts" {
			sawArtifacts = true
		}
		if m.Version == 11 && m.Name == "audit_integrity" {
			sawAuditIntegrity = true
		}
		if m.Version == 12 && m.Name == "kubernetes_read" {
			sawKubernetesRead = true
		}
		if m.Version == 17 && m.Name == "embed_validation" {
			sawEmbedValidation = true
		}
		if m.Version == 18 && m.Name == "platform_admin" {
			sawPlatformAdmin = true
		}
		if m.Version == 22 && m.Name == "adv019_revoke_sessions_on_workspace_delete" {
			sawWorkspaceSessionRevoke = true
		}
		if m.Version == 23 && m.Name == "workflow_folders" {
			sawWorkflowFolders = true
		}
	}
	if !sawIsolation {
		t.Fatal("expected 000003_workspace_isolation.sql")
	}
	if !sawSessions {
		t.Fatal("expected 000004_browser_sessions.sql")
	}
	if !sawWorkflows {
		t.Fatal("expected 000005_workflows.sql")
	}
	if !sawCredentials {
		t.Fatal("expected 000006_credentials.sql")
	}
	if !sawOps {
		t.Fatal("expected 000007_ops_config.sql")
	}
	if !sawApprovals {
		t.Fatal("expected 000008_approvals.sql")
	}
	if !sawExecutions {
		t.Fatal("expected 000009_executions.sql")
	}
	if !sawArtifacts {
		t.Fatal("expected 000010_execution_artifacts.sql")
	}
	if !sawAuditIntegrity {
		t.Fatal("expected 000011_audit_integrity.sql")
	}
	if !sawKubernetesRead {
		t.Fatal("expected 000012_kubernetes_read.sql")
	}
	if !sawEmbedValidation {
		t.Fatal("expected 000017_embed_validation.sql")
	}
	if !sawPlatformAdmin {
		t.Fatal("expected 000018_platform_admin.sql")
	}
	if !sawWorkspaceSessionRevoke {
		t.Fatal("expected 000022_adv019_revoke_sessions_on_workspace_delete.sql")
	}
	if !sawWorkflowFolders {
		t.Fatal("expected 000023_workflow_folders.sql")
	}
	seen := make(map[int64]string, len(all))
	for _, m := range all {
		if prev, ok := seen[m.Version]; ok {
			t.Fatalf("duplicate migration version %d (%s and %s)", m.Version, prev, m.Name)
		}
		seen[m.Version] = m.Name
	}
	if seen[29] != "oidc_pkce_mfa" {
		t.Fatalf("migration 29 = %q, want oidc_pkce_mfa", seen[29])
	}
	if seen[30] != "job_trace_context" {
		t.Fatalf("migration 30 = %q, want job_trace_context", seen[30])
	}
	if seen[31] != "scim_lockout" {
		t.Fatalf("migration 31 = %q, want scim_lockout", seen[31])
	}
}

func TestPendingMigrationsRejectsRecordedNameMismatch(t *testing.T) {
	all := []migration{
		{Version: 29, Name: "oidc_pkce_mfa"},
		{Version: 30, Name: "job_trace_context"},
	}
	pending, err := pendingMigrations(all, map[int64]string{29: "oidc_pkce_mfa"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Name != "job_trace_context" {
		t.Fatalf("pending = %+v", pending)
	}
	_, err = pendingMigrations(all, map[int64]string{29: "job_trace_context"})
	if !errors.Is(err, ErrMigrationDrift) {
		t.Fatalf("expected recorded name mismatch to refuse boot, got %v", err)
	}
	if !strings.Contains(err.Error(), "refusing boot") || !strings.Contains(err.Error(), "job_trace_context") {
		t.Fatalf("operator error = %v", err)
	}
}

func TestChecksumBytesIsSHA256(t *testing.T) {
	// SHA-256 of the empty input. Pins the algorithm operators compare with sha256sum.
	const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got := checksumBytes(nil); got != empty {
		t.Fatalf("checksum = %s", got)
	}
	if got := checksumBytes([]byte{}); got != empty {
		t.Fatalf("checksum = %s", got)
	}
}

func TestCleanTreeChecksumVerificationSucceeds(t *testing.T) {
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) == 0 {
		t.Fatal("expected migrations")
	}
	applied := make(map[int64]appliedMigration, len(all))
	for _, m := range all {
		if len(m.Checksum) != 64 {
			t.Fatalf("version %d checksum = %q", m.Version, m.Checksum)
		}
		if m.Checksum != checksumBytes([]byte(m.SQL)) {
			t.Fatalf("version %d checksum does not match file bytes", m.Version)
		}
		applied[m.Version] = appliedMigration{Name: m.Name, Checksum: m.Checksum}
	}
	if err := verifyAppliedChecksums(all, applied); err != nil {
		t.Fatal(err)
	}
	pending, err := pendingMigrations(all, appliedNames(applied))
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("clean tree pending = %d", len(pending))
	}
}

func TestChecksumDriftRefusesBoot(t *testing.T) {
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	applied := make(map[int64]appliedMigration, len(all))
	for _, m := range all {
		applied[m.Version] = appliedMigration{Name: m.Name, Checksum: m.Checksum}
	}
	const recorded = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	applied[1] = appliedMigration{Name: "foundation", Checksum: recorded}

	err = verifyAppliedChecksums(all, applied)
	if !errors.Is(err, ErrMigrationDrift) {
		t.Fatalf("expected drift, got %v", err)
	}
	msg := err.Error()
	for _, want := range []string{
		"refusing boot",
		"version 1",
		"foundation",
		"000001_foundation.sql",
		recorded,
		"docs/operations/schema-migrations.md#refused-boot",
		"do not edit applied SQL",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q missing %q", msg, want)
		}
	}
	if strings.Contains(msg, "SELECT 1") || strings.Contains(msg, "Forward-only foundation") {
		t.Fatalf("operator error included migration SQL: %s", msg)
	}
	var drift *migrationDriftError
	if !errors.As(err, &drift) {
		t.Fatal("expected migrationDriftError")
	}
	if drift.Actual == recorded || drift.Actual == "" {
		t.Fatalf("actual checksum = %q", drift.Actual)
	}
}

func TestMissingMigrationFileRefusesBoot(t *testing.T) {
	all := []migration{{
		Version:  2,
		Name:     "identity_rbac",
		Checksum: checksumBytes([]byte("select 1")),
	}}
	err := verifyAppliedChecksums(all, map[int64]appliedMigration{
		1: {Name: "foundation", Checksum: checksumBytes([]byte("select 1"))},
	})
	if !errors.Is(err, ErrMigrationDrift) {
		t.Fatalf("expected missing file to refuse boot, got %v", err)
	}
	msg := err.Error()
	if !strings.Contains(msg, "version 1") || !strings.Contains(msg, "000001_foundation.sql") || !strings.Contains(msg, "no file in this binary") {
		t.Fatalf("error = %s", msg)
	}
	if strings.Contains(msg, "select 1") {
		t.Fatalf("operator error included migration SQL: %s", msg)
	}
}

func TestLegacyEmptyChecksumIsStampedNotDrift(t *testing.T) {
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	applied := map[int64]appliedMigration{
		all[0].Version: {Name: all[0].Name, Checksum: ""},
	}
	if err := verifyAppliedChecksums(all[:1], applied); err != nil {
		t.Fatalf("empty checksum must not refuse boot before stamp: %v", err)
	}
}

func TestWrappedDriftIsPermanent(t *testing.T) {
	inner := &migrationDriftError{
		Version: 3,
		Name:    "workspace_isolation",
		File:    "000003_workspace_isolation.sql",
		Reason:  driftChecksum,
	}
	// connectAndMigrate wraps with %w. Start must still see the sentinel and not retry.
	wrapped := fmt.Errorf("migrate: %w", inner)
	if !errors.Is(wrapped, ErrMigrationDrift) {
		t.Fatal("expected wrapped drift")
	}
}

// isolatedDatabaseURL clones dsn onto a new empty database so checksum
// tamper tests cannot fail a shared schema_migrations used by other packages.
func isolatedDatabaseURL(t *testing.T, dsn string) string {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	maint := cfg.ConnConfig.Copy()
	maint.Database = "postgres"
	conn, err := pgx.ConnectConfig(ctx, maint)
	if err != nil {
		t.Fatalf("maintenance connection: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	name := "ff_mig_" + strings.ToLower(strconv.FormatInt(time.Now().UnixNano(), 36))
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer ccancel()
		c, err := pgx.ConnectConfig(cctx, maint)
		if err != nil {
			t.Errorf("drop database connect: %v", err)
			return
		}
		defer func() { _ = c.Close(cctx) }()
		if _, err := c.Exec(cctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("drop database %s: %v", name, err)
		}
	})
	cfg.ConnConfig.Database = name
	return cfg.ConnString()
}

func TestMigrateChecksumHappyPathAndDrift(t *testing.T) {
	dsn := testDatabaseURL()
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	dsn = isolatedDatabaseURL(t, dsn)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatalf("clean boot: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	var version int64
	var name, checksum string
	if err := pool.QueryRow(ctx, `SELECT version, name, checksum FROM schema_migrations WHERE version = 1`).Scan(&version, &name, &checksum); err != nil {
		t.Fatal(err)
	}
	if version != 1 || name != "foundation" || len(checksum) != 64 {
		t.Fatalf("recorded version=%d name=%q checksum=%q", version, name, checksum)
	}
	var missing int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE checksum IS NULL OR length(checksum) <> 64`).Scan(&missing); err != nil {
		t.Fatal(err)
	}
	if missing != 0 {
		t.Fatalf("applied rows missing checksum: %d", missing)
	}

	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("second boot: %v", err)
	}

	const tampered = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET checksum = $1 WHERE version = 1`, tampered); err != nil {
		t.Fatal(err)
	}
	// Registered after Close so it runs first (cleanups are LIFO) while the pool is open.
	t.Cleanup(func() {
		restoreCtx, restoreCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer restoreCancel()
		if _, err := pool.Exec(restoreCtx, `UPDATE schema_migrations SET checksum = $1 WHERE version = 1`, checksum); err != nil {
			t.Errorf("restore foundation checksum: %v", err)
		}
	})

	err = Migrate(ctx, pool)
	if !errors.Is(err, ErrMigrationDrift) {
		t.Fatalf("expected drift to refuse boot, got %v", err)
	}
	msg := err.Error()
	for _, want := range []string{"refusing boot", "version 1", "foundation", "000001_foundation.sql", tampered} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q missing %q", msg, want)
		}
	}

	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET checksum = NULL WHERE version = 1`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("legacy null checksum should stamp and boot: %v", err)
	}
	var stamped string
	if err := pool.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version = 1`).Scan(&stamped); err != nil {
		t.Fatal(err)
	}
	if stamped != checksum {
		t.Fatalf("stamped checksum = %s, want %s", stamped, checksum)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("boot after stamp: %v", err)
	}
}

func TestStartRefusesBootOnChecksumDrift(t *testing.T) {
	dsn := testDatabaseURL()
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	dsn = isolatedDatabaseURL(t, dsn)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	admin, err := OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })

	var checksum string
	if err := admin.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version = 1`).Scan(&checksum); err != nil {
		t.Fatal(err)
	}
	const tampered = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
	if _, err := admin.Exec(ctx, `UPDATE schema_migrations SET checksum = $1 WHERE version = 1`, tampered); err != nil {
		t.Fatal(err)
	}
	// Registered after Close so it runs first (cleanups are LIFO) while the pool is open.
	t.Cleanup(func() {
		restoreCtx, restoreCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer restoreCancel()
		if _, err := admin.Exec(restoreCtx, `UPDATE schema_migrations SET checksum = $1 WHERE version = 1`, checksum); err != nil {
			t.Errorf("restore foundation checksum: %v", err)
		}
	})

	pool := NewPool(dsn, nil, 0)
	startCtx, startCancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer startCancel()
	started := time.Now()
	pool.Start(startCtx)
	elapsed := time.Since(started)
	if startCtx.Err() != nil {
		t.Fatalf("start waited for context (%s); drift must refuse boot without retry", elapsed)
	}
	if err := pool.Ping(context.Background()); err == nil {
		t.Fatal("readiness ping succeeded after checksum drift")
	}
}

func TestMigrateSerializesConcurrentRunners(t *testing.T) {
	dsn := testDatabaseURL()
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pool, err := Open(ctx, dsn)
			if err != nil {
				errs <- err
				return
			}
			pool.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent migrate: %v", err)
	}
}
