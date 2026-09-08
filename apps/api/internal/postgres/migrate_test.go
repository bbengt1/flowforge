package postgres

import "testing"

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
}
