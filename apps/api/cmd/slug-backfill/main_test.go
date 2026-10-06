package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestRunRejectsMissingInput(t *testing.T) {
	ctx := context.Background()
	if err := run(ctx, "", "6a1f0e9e-6f43-4b8c-9a55-1f6e4f1e8a10", &bytes.Buffer{}); err == nil {
		t.Fatal("missing DATABASE_URL accepted")
	}
	for _, ws := range []string{"", "not-a-uuid", "acme/ops"} {
		if err := run(ctx, "postgres://unused", ws, &bytes.Buffer{}); !errors.Is(err, errUsage) {
			t.Fatalf("workspace %q = %v", ws, err)
		}
	}
}

func TestRunTwicePrintsChangedThenZero(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
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

	ids := identity.NewPostgres(admin)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	tenant, err := ids.CreateTenant(ctx, "sb-"+suffix[len(suffix)-12:], "SB")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", "sb-"+suffix, "SB")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, "sb-"+suffix[len(suffix)-8:], "SB", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	src := "apiVersion: flowforge/v1\nkind: Workflow\nmetadata:\n  name: Backfill Me\nspec:\n  triggers:\n    - id: manual\n      type: manual\n  nodes:\n    - id: done\n      type: flow.stop\n      name: Stop\n  edges: []\n"
	res, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	wf, _, err := wfstore.NewPostgres(app).Create(ctx, scope, wfstore.CreateInput{
		Name: "Backfill Me", NormalizedYAML: res.NormalizedYAML, Digest: res.Digest, Summary: res.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Leave the drift a pre-#557 save could: metadata.slug != stored slug.
	if _, err := admin.Exec(ctx, `UPDATE workflow_drafts SET normalized_yaml = $2, definition_digest = $3 WHERE workflow_id = $1::uuid`,
		wf.ID, res.NormalizedYAML, res.Digest); err != nil {
		t.Fatal(err)
	}

	var first, second bytes.Buffer
	if err := run(ctx, dsn, ws.ID, &first); err != nil {
		t.Fatal(err)
	}
	if err := run(ctx, dsn, ws.ID, &second); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("workspace=%s\nscanned=1\nchanged=1\nskipped=0\n", ws.ID)
	if first.String() != want {
		t.Fatalf("first run:\n%s\nwant:\n%s", first.String(), want)
	}
	if !strings.Contains(second.String(), "\nchanged=0\n") {
		t.Fatalf("second run:\n%s", second.String())
	}
	var yamlDoc string
	if err := admin.QueryRow(ctx, `SELECT normalized_yaml FROM workflow_drafts WHERE workflow_id = $1::uuid`, wf.ID).Scan(&yamlDoc); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(yamlDoc, "\n  slug: "+wf.Slug+"\n") {
		t.Fatalf("draft slug not backfilled:\n%s", yamlDoc)
	}
}
