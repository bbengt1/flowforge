package wfstore

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestMemoryDerivedSlugFromName(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	assertDerivedSlugBehavior(t, ctx, store, testWorkflowScope(t))
}

func TestPostgresDerivedSlugFromName(t *testing.T) {
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

	store := NewPostgres(app)
	wsA, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	assertDerivedSlugBehavior(t, ctx, store, scope)
	assertDerivedSlugUniqueRetry(t, ctx, store, scope)
}

func assertDerivedSlugBehavior(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) {
	t.Helper()

	t.Run("delete then name-only create suffixes", func(t *testing.T) {
		first := createNamed(t, ctx, store, scope, "Redeploy", "")
		if first.Slug != "redeploy" {
			t.Fatalf("first slug = %q", first.Slug)
		}
		assertStoredSlug(t, ctx, store, scope, first.ID, "redeploy")
		if _, err := store.Delete(ctx, scope, first.ID); err != nil {
			t.Fatal(err)
		}
		second := createNamed(t, ctx, store, scope, "Redeploy", "")
		if second.Slug != "redeploy-2" {
			t.Fatalf("second slug = %q", second.Slug)
		}
		assertStoredSlug(t, ctx, store, scope, second.ID, "redeploy-2")
	})

	t.Run("same name gets x and x-2", func(t *testing.T) {
		a := createNamed(t, ctx, store, scope, "X", "")
		b := createNamed(t, ctx, store, scope, "X", "")
		if a.Slug != "x" || b.Slug != "x-2" {
			t.Fatalf("slugs = %q %q", a.Slug, b.Slug)
		}
	})

	t.Run("explicit live clash is not rewritten", func(t *testing.T) {
		live := createNamed(t, ctx, store, scope, "Taken", "taken-live")
		_, _, err := store.Create(ctx, scope, slugCreateInput(t, "Other", "taken-live"))
		var conflict SlugConflict
		if !errors.As(err, &conflict) || conflict.Reserved || conflict.Exhausted || !errors.Is(err, ErrConflict) {
			t.Fatalf("live clash = %v", err)
		}
		got, getErr := store.Get(ctx, scope, live.ID)
		if getErr != nil || got.Slug != "taken-live" {
			t.Fatalf("live slug rewritten: %+v %v", got, getErr)
		}
	})

	t.Run("explicit deleted clash is reserved", func(t *testing.T) {
		row := createNamed(t, ctx, store, scope, "Gone", "taken-gone")
		if _, err := store.Delete(ctx, scope, row.ID); err != nil {
			t.Fatal(err)
		}
		_, _, err := store.Create(ctx, scope, slugCreateInput(t, "Again", "taken-gone"))
		var conflict SlugConflict
		if !errors.As(err, &conflict) || !conflict.Reserved || !errors.Is(err, ErrSlugReserved) {
			t.Fatalf("deleted clash = %v", err)
		}
	})

	t.Run("emoji name falls back to workflow", func(t *testing.T) {
		row := createNamed(t, ctx, store, scope, "🎉", "")
		if row.Slug != "workflow" {
			t.Fatalf("slug = %q", row.Slug)
		}
		assertStoredSlug(t, ctx, store, scope, row.ID, "workflow")
	})

	t.Run("reserved derived word is suffixed", func(t *testing.T) {
		row := createNamed(t, ctx, store, scope, "Catalog", "")
		if row.Slug != "catalog-2" {
			t.Fatalf("slug = %q", row.Slug)
		}
		assertStoredSlug(t, ctx, store, scope, row.ID, "catalog-2")
	})

	t.Run("yaml slug beats derived name", func(t *testing.T) {
		in := slugCreateInput(t, "Deploy API", "")
		normalized := mustNormalize(t, slugYAML("Deploy API", "from-yaml"))
		in.NormalizedYAML = normalized.NormalizedYAML
		in.Digest = normalized.Digest
		in.Summary = normalized.Summary
		in.Slug = ""
		wf, draft, err := store.Create(ctx, scope, in)
		if err != nil {
			t.Fatal(err)
		}
		if wf.Slug != "from-yaml" {
			t.Fatalf("slug = %q", wf.Slug)
		}
		assertYAMLSlug(t, draft.DefinitionYAML, "from-yaml")
	})

	t.Run("body slug beats yaml slug", func(t *testing.T) {
		normalized := mustNormalize(t, slugYAML("Deploy API", "from-yaml-2"))
		wf, draft, err := store.Create(ctx, scope, CreateInput{
			Slug:           "from-body",
			Name:           "Deploy API",
			NormalizedYAML: normalized.NormalizedYAML,
			Digest:         normalized.Digest,
			Summary:        normalized.Summary,
		})
		if err != nil {
			t.Fatal(err)
		}
		if wf.Slug != "from-body" || wf.Name != "Deploy API" {
			t.Fatalf("create = name %q slug %q", wf.Name, wf.Slug)
		}
		assertYAMLSlug(t, draft.DefinitionYAML, "from-body")
	})

	t.Run("63-character derived slug is trimmed before -2", func(t *testing.T) {
		name := strings.Repeat("a", 63)
		first := createNamed(t, ctx, store, scope, name, "")
		second := createNamed(t, ctx, store, scope, name, "")
		assertCappedSuffix(t, first.Slug, second.Slug, strings.Repeat("a", 61)+"-2")
		assertStoredSlug(t, ctx, store, scope, second.ID, second.Slug)
	})

	t.Run("suffix trim drops a hyphen left at the cut", func(t *testing.T) {
		// 60 letters, a hyphen, then two letters: 63 characters. Cutting
		// room for "-2" lands on that hyphen, which must be removed.
		name := strings.Repeat("b", 60) + "-cd"
		first := createNamed(t, ctx, store, scope, name, "")
		second := createNamed(t, ctx, store, scope, name, "")
		assertCappedSuffix(t, first.Slug, second.Slug, strings.Repeat("b", 60)+"-2")
		if strings.Contains(second.Slug, "--") {
			t.Fatalf("suffix kept the cut hyphen: %q", second.Slug)
		}
		assertStoredSlug(t, ctx, store, scope, second.ID, second.Slug)
	})

	t.Run("derived suffixes stop after the attempt cap", func(t *testing.T) {
		for i := 0; i < maxDerivedSlugAttempts; i++ {
			row := createNamed(t, ctx, store, scope, "Quota", "")
			if row.Slug == "" {
				t.Fatal("empty slug")
			}
		}
		_, _, err := store.Create(ctx, scope, slugCreateInput(t, "Quota", ""))
		var conflict SlugConflict
		if !errors.As(err, &conflict) || !conflict.Exhausted || !errors.Is(err, ErrConflict) {
			t.Fatalf("exhausted = %v", err)
		}
	})
}

func assertDerivedSlugUniqueRetry(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) {
	t.Helper()
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var releaseOnce sync.Once
	letGo := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(letGo)

	blocked := withSlugInsertHook(ctx, func(attempt int, slug string) {
		if attempt == 1 && slug == "race" {
			once.Do(func() { close(started) })
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
	})
	errCh := make(chan error, 1)
	var retried Workflow
	blockedInput := slugCreateInput(t, "Race", "")
	go func() {
		var err error
		retried, _, err = store.Create(blocked, scope, blockedInput)
		errCh <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("slug insert hook did not run")
	}
	winner, _, err := store.Create(ctx, scope, slugCreateInput(t, "Race", ""))
	letGo()
	if err != nil {
		t.Fatal(err)
	}
	if waitErr := <-errCh; waitErr != nil {
		t.Fatal(waitErr)
	}
	if winner.Slug != "race" || retried.Slug != "race-2" {
		t.Fatalf("concurrent slugs winner=%q retried=%q", winner.Slug, retried.Slug)
	}
	assertStoredSlug(t, ctx, store, scope, winner.ID, "race")
	assertStoredSlug(t, ctx, store, scope, retried.ID, "race-2")
}

func assertCappedSuffix(t *testing.T, first, second, wantSecond string) {
	t.Helper()
	if len(first) != maxWorkflowSlugLen || !workflow.ValidWorkflowSlug(first) {
		t.Fatalf("first slug = %q", first)
	}
	if second != wantSecond || len(second) > maxWorkflowSlugLen || !strings.HasSuffix(second, "-2") || !workflow.ValidWorkflowSlug(second) {
		t.Fatalf("second slug = %q, want %q", second, wantSecond)
	}
	if strings.HasSuffix(strings.TrimSuffix(second, "-2"), "-") {
		t.Fatalf("base kept a trailing hyphen: %q", second)
	}
}

func createNamed(t *testing.T, ctx context.Context, store Store, scope isolation.Scope, name, slug string) Workflow {
	t.Helper()
	wf, draft, err := store.Create(ctx, scope, slugCreateInput(t, name, slug))
	if err != nil {
		t.Fatal(err)
	}
	if wf.Name != name {
		t.Fatalf("name = %q", wf.Name)
	}
	assertYAMLSlug(t, draft.DefinitionYAML, wf.Slug)
	if workflow.Digest(draft.DefinitionYAML) != draft.Digest {
		t.Fatal("stored digest does not match yaml")
	}
	return wf
}

func slugCreateInput(t *testing.T, name, slug string) CreateInput {
	t.Helper()
	normalized := mustNormalize(t, slugYAML(name, ""))
	in := CreateInput{
		Name:           name,
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	}
	if slug != "" {
		in.Slug = slug
	}
	return in
}

func slugYAML(name, slug string) string {
	slugLine := ""
	if slug != "" {
		slugLine = "\n  slug: " + slug
	}
	return fmt.Sprintf(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: %s%s
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: done
      type: flow.stop
      name: Stop
  edges: []
`, strconv.Quote(name), slugLine)
}

func assertStoredSlug(t *testing.T, ctx context.Context, store Store, scope isolation.Scope, id, slug string) {
	t.Helper()
	draft, err := store.GetDraft(ctx, scope, id)
	if err != nil {
		t.Fatal(err)
	}
	assertYAMLSlug(t, draft.DefinitionYAML, slug)
	if workflow.Digest(draft.DefinitionYAML) != draft.Digest {
		t.Fatal("draft digest drifted")
	}
}

func assertYAMLSlug(t *testing.T, yamlDoc, slug string) {
	t.Helper()
	doc, errs := workflow.Parse([]byte(yamlDoc))
	if len(errs) > 0 || doc == nil {
		t.Fatalf("stored yaml: %+v\n%s", errs, yamlDoc)
	}
	if doc.Metadata.Slug != slug {
		t.Fatalf("metadata.slug = %q, want %q\n%s", doc.Metadata.Slug, slug, yamlDoc)
	}
	if !strings.Contains(yamlDoc, "slug: "+slug) {
		t.Fatalf("yaml missing slug line %q\n%s", slug, yamlDoc)
	}
}
