package wfstore

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresWorkflowKeysetAndSearch(t *testing.T) {
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

	want := map[string]struct{}{}
	for _, slug := range []string{"page-alpha", "page-beta", "page-gamma"} {
		src := strings.Replace(fixtureYAML, "name: restart-api-rollout", "name: "+slug, 1)
		normalized := mustNormalize(t, src)
		wf, _, err := store.Create(ctx, scopeA, CreateInput{
			Slug:           slug,
			NormalizedYAML: normalized.NormalizedYAML,
			Digest:         normalized.Digest,
			Summary:        normalized.Summary,
		})
		if err != nil {
			t.Fatal(err)
		}
		want[wf.ID] = struct{}{}
		time.Sleep(time.Millisecond)
	}

	seen := map[string]struct{}{}
	var next string
	q := page.Query{Bound: true, Limit: 2, Next: &next}
	for n := 0; n < 4; n++ {
		items, err := store.List(ctx, scopeA, WorkflowListFilter{Page: q})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			if _, ok := want[item.ID]; !ok {
				t.Fatalf("unexpected workflow %s", item.ID)
			}
			seen[item.ID] = struct{}{}
		}
		if next == "" {
			break
		}
		q.Cursor = next
		next = ""
	}
	if len(seen) != len(want) {
		t.Fatalf("walked %d, want %d", len(seen), len(want))
	}
	if next != "" {
		t.Fatalf("final next = %q", next)
	}

	var searchNext string
	search := page.Query{Bound: true, Limit: 50, Q: "page-beta", Next: &searchNext}
	found, err := store.List(ctx, scopeA, WorkflowListFilter{Page: search})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].Slug != "page-beta" || searchNext != "" {
		t.Fatalf("search = %+v next %q", found, searchNext)
	}

	var otherNext string
	other := page.Query{Bound: true, Limit: 50, Next: &otherNext}
	cross, err := store.List(ctx, scopeB, WorkflowListFilter{Page: other})
	if err != nil {
		t.Fatal(err)
	}
	if len(cross) != 0 || otherNext != "" {
		t.Fatalf("cross-workspace page = %+v next %q", cross, otherNext)
	}
}
