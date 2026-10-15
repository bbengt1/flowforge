package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.2: publish records workflow_versions.catalog_revision and the
// static FFX refs, and is pinned to the checked draft digest.

const catalogRevisionYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: catalog-revision
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: note
      type: data.set
      name: Note
      with:
        value:
          seen: true
`

func runCatalogRevisionSuite(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) {
	t.Helper()
	normalized := mustNormalize(t, catalogRevisionYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{NormalizedYAML: normalized.NormalizedYAML, Digest: normalized.Digest, Summary: normalized.Summary})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, CheckedDigest: "sha256:not-the-draft"}); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale checked digest: %v", err)
	}
	refs := []workflow.ExpressionRef{{NodeID: "note", Field: "when", Type: "bool", Inputs: []workflow.InputRef{{Port: "config", From: "up.result"}}, Vars: []string{"k"}}}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, CheckedDigest: draft.Digest, Expressions: refs})
	if err != nil {
		t.Fatal(err)
	}
	check := func(where string, v Version) {
		t.Helper()
		if v.CatalogRevision == nil || *v.CatalogRevision != workflow.CatalogRevision {
			t.Fatalf("%s: catalogRevision = %v", where, v.CatalogRevision)
		}
		if len(v.Summary.Expressions) != 1 || v.Summary.Expressions[0].Inputs[0].From != "up.result" || v.Summary.Expressions[0].Vars[0] != "k" {
			t.Fatalf("%s: expressions = %+v", where, v.Summary.Expressions)
		}
		if v.Digest != draft.Digest {
			t.Fatalf("%s: digest changed", where)
		}
	}
	check("publish", ver)
	got, err := store.GetVersion(ctx, scope, wf.ID, ver.ID)
	if err != nil {
		t.Fatal(err)
	}
	check("get", got)
	list, err := store.ListVersions(ctx, scope, wf.ID)
	if err != nil || len(list) != 1 {
		t.Fatalf("list %v %v", list, err)
	}
	check("list", list[0])
	// The draft summary never carries version-only expression refs.
	d, err := store.GetDraft(ctx, scope, wf.ID)
	if err != nil || len(d.Summary.Expressions) != 0 {
		t.Fatalf("draft summary %+v %v", d.Summary.Expressions, err)
	}
}

func TestMemoryCatalogRevision650(t *testing.T) {
	scope, _ := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	runCatalogRevisionSuite(t, context.Background(), NewMemory(), scope)
}

func TestPostgresCatalogRevision650(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
	wsA, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, _ := isolation.Authorize(wsA, userID)
	runCatalogRevisionSuite(t, ctx, NewPostgres(app), scope)

	t.Run("column is nullable for legacy versions and range-checked", func(t *testing.T) {
		var nullable string
		if err := admin.QueryRow(ctx, `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'workflow_versions' AND column_name = 'catalog_revision'`).Scan(&nullable); err != nil || nullable != "YES" {
			t.Fatalf("nullable = %q %v", nullable, err)
		}
		var ok bool
		if err := admin.QueryRow(ctx, `SELECT bool_and(catalog_revision IS NULL OR catalog_revision >= 1) FROM workflow_versions`).Scan(&ok); err != nil || !ok {
			t.Fatalf("range %v %v", ok, err)
		}
	})
}
