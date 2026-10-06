package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
	if err := run(ctx, "", "6a1f0e9e-6f43-4b8c-9a55-1f6e4f1e8a10", &bytes.Buffer{}, nil); err == nil {
		t.Fatal("missing DATABASE_URL accepted")
	}
	for _, ws := range []string{"", "not-a-uuid", "acme/ops"} {
		if err := run(ctx, "postgres://unused", ws, &bytes.Buffer{}, nil); !errors.Is(err, errUsage) {
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

	var first, second, firstLog, secondLog bytes.Buffer
	if err := run(ctx, dsn, ws.ID, &first, testLogger(&firstLog)); err != nil {
		t.Fatal(err)
	}
	if err := run(ctx, dsn, ws.ID, &second, testLogger(&secondLog)); err != nil {
		t.Fatal(err)
	}
	lines := logLines(t, &firstLog)
	if len(lines) != 1 {
		t.Fatalf("first run logged %d lines, want 1:\n%s", len(lines), firstLog.String())
	}
	want := map[string]any{
		"msg": "slug-backfill draft changed", "workspace_id": ws.ID, "workflow_id": wf.ID,
		"old_slug": "", "old_slug_missing": true, "new_slug": wf.Slug,
	}
	for k, v := range want {
		if lines[0][k] != v {
			t.Fatalf("log %s = %v, want %v (line %v)", k, lines[0][k], v, lines[0])
		}
	}
	if strings.Contains(firstLog.String(), "apiVersion") || strings.Contains(firstLog.String(), "postgres://") {
		t.Fatalf("log carries YAML or the connection string:\n%s", firstLog.String())
	}
	if secondLog.Len() != 0 {
		t.Fatalf("second run logged:\n%s", secondLog.String())
	}
	summary := fmt.Sprintf("workspace=%s\nscanned=1\nchanged=1\nskipped=0\n", ws.ID)
	if first.String() != summary {
		t.Fatalf("first run:\n%s\nwant:\n%s", first.String(), summary)
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

func testLogger(w *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

func logLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimRight(buf.String(), "\n"), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line is not JSON: %q", line)
		}
		out = append(out, m)
	}
	return out
}

func TestLogSafeEscapesControlCharacters(t *testing.T) {
	for in, want := range map[string]string{
		"deploy-api":                 "deploy-api",
		"":                           "",
		"a\nlevel=ERROR msg=forged":  `a\nlevel=ERROR msg=forged`,
		"a\r\n{\"level\":\"ERROR\"}": `a\r\n{\"level\":\"ERROR\"}`,
		"bell\x07esc\x1b[31m":        `bell\aesc\x1b[31m`,
		"line\u2028sep\u2029":        `line\u2028sep\u2029`,
		"tab\there":                  `tab\there`,
		"back\\slash":                `back\\slash`,
	} {
		got := logSafe(in)
		if got != want {
			t.Fatalf("logSafe(%q) = %q, want %q", in, got, want)
		}
		for _, r := range got {
			if r < 0x20 || r > 0x7e {
				t.Fatalf("logSafe(%q) kept %U", in, r)
			}
		}
	}
	long := strings.Repeat("a", 500)
	if got := logSafe(long); len(got) != maxLoggedSlugRunes+3 || !strings.HasSuffix(got, "...") {
		t.Fatalf("long value = %d chars", len(got))
	}
}

func TestLogChangeIsOneLineForHostileSlug(t *testing.T) {
	var buf bytes.Buffer
	logChange(testLogger(&buf), "6a1f0e9e-6f43-4b8c-9a55-1f6e4f1e8a10", wfstore.DraftSlugChange{
		WorkflowID: "0b8a6f7e-2a55-4c1e-9d55-7a1d2c3e4f50",
		OldSlug:    "old\n{\"level\":\"ERROR\",\"msg\":\"forged\"}\u2028x",
		NewSlug:    "deploy-api",
	})
	if strings.Count(buf.String(), "\n") != 1 {
		t.Fatalf("hostile slug split the log line:\n%s", buf.String())
	}
	lines := logLines(t, &buf)
	if len(lines) != 1 || lines[0]["level"] != "INFO" || lines[0]["old_slug_missing"] != false {
		t.Fatalf("lines = %v", lines)
	}
	old, _ := lines[0]["old_slug"].(string)
	if strings.ContainsAny(old, "\n\r\u2028") || !strings.Contains(old, `\n`) {
		t.Fatalf("old_slug = %q", old)
	}
}
