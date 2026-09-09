package postgres

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"
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
	var sawIsolation, sawSessions, sawWorkflows, sawCredentials, sawOps bool
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
}

func TestMigrateSerializesConcurrentRunners(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
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
