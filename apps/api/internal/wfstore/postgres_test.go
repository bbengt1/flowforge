package wfstore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	return dsn
}

func TestPostgresImmutabilityPinningAndIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)

	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	store := NewPostgres(app)
	wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scopeA, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}

	normalized := mustNormalize(t, fixtureYAML)
	wf, draft, err := store.Create(ctx, scopeA, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, scopeB, wf.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace get: %v", err)
	}

	_, ver, err := store.Publish(ctx, scopeA, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "pin"})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("versions are immutable", func(t *testing.T) {
		_, err := admin.Exec(ctx, `UPDATE workflow_versions SET publish_note = 'mutated' WHERE id = $1::uuid`, ver.ID)
		if err == nil {
			t.Fatal("expected version update to fail")
		}
		if !errors.Is(mapDBErr(err), ErrImmutable) {
			t.Fatalf("mapDBErr = %v (raw %v), want ErrImmutable", mapDBErr(err), err)
		}
		var note string
		if err := admin.QueryRow(ctx, `SELECT publish_note FROM workflow_versions WHERE id = $1::uuid`, ver.ID).Scan(&note); err != nil {
			t.Fatal(err)
		}
		if note != "pin" {
			t.Fatalf("version mutated: %q", note)
		}
	})

	exec, err := store.StartExecution(ctx, scopeA, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetExecution(ctx, scopeB, wf.ID, exec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace execution: %v", err)
	}

	t.Run("execution pin cannot move", func(t *testing.T) {
		_, err := admin.Exec(ctx, `
			UPDATE executions SET workflow_digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
			WHERE id = $1::uuid
		`, exec.ID)
		if err == nil {
			t.Fatal("expected pin update to fail")
		}
		if !errors.Is(mapDBErr(err), ErrImmutable) {
			t.Fatalf("mapDBErr = %v (raw %v), want ErrImmutable", mapDBErr(err), err)
		}
		got, err := store.GetExecution(ctx, scopeA, wf.ID, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.WorkflowDigest != ver.Digest || got.WorkflowVersionID != ver.ID {
			t.Fatalf("pin drifted: %+v", got)
		}
	})

	t.Run("force rls is enabled", func(t *testing.T) {
		for _, table := range []string{"workflows", "workflow_drafts", "workflow_versions", "executions"} {
			var forced bool
			err := admin.QueryRow(ctx, `
				SELECT c.relforcerowsecurity
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relname = $1
			`, table).Scan(&forced)
			if err != nil {
				t.Fatal(err)
			}
			if !forced {
				t.Fatalf("%s missing FORCE ROW LEVEL SECURITY", table)
			}
		}
	})
}

func seedWorkflowWorkspaces(t *testing.T, ctx context.Context, db identity.DB) (string, string, string) {
	t.Helper()
	store := identity.NewPostgres(db)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	tenant, err := store.CreateTenant(ctx, "wf-"+suffix[:10], "WF")
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUser(ctx, "https://idp.example", "wf-"+suffix, "WF")
	if err != nil {
		t.Fatal(err)
	}
	a, err := store.CreateWorkspace(ctx, tenant.ID, "bench-a-"+suffix[len(suffix)-8:], "A", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := store.CreateWorkspace(ctx, tenant.ID, "bench-b-"+suffix[len(suffix)-8:], "B", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	return a.ID, b.ID, user.ID
}
