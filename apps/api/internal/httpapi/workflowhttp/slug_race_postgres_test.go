package workflowhttp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// slugRaceOutcome is one create mapped through the same problem writer
// the HTTP handler uses.
type slugRaceOutcome struct {
	slug    string
	status  int
	problem core.Problem
}

// TestPostgresConcurrentSlugCreatesNeverConflictOr500 runs concurrent
// creates of one name and one explicit slug against PostgreSQL. Every
// result is a success or a slug 409 on path slug (workflow_slug_taken, or
// workflow_slug_reserved for a deleted holder). Never 500, never conflict.
// Same-base name-only creates serialize on the advisory lock, so all of
// them return 201 with distinct slugs and no client retry. Explicit
// creates of one slug have exactly one winner.
func TestPostgresConcurrentSlugCreatesNeverConflictOr500(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	tenant, err := ids.CreateTenant(ctx, "slugrace-"+suffix[len(suffix)-10:], "Slug race")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", "slugrace-"+suffix, "Racer")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, "race-"+suffix[len(suffix)-8:], "Race", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	store := wfstore.NewPostgres(app)

	normalized, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: Burst
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: done
      type: flow.stop
      name: Stop
  edges: []
`))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	input := func(slug string, derived bool) wfstore.CreateInput {
		return wfstore.CreateInput{
			Slug:           slug,
			SlugDerived:    derived,
			Name:           "Burst",
			NormalizedYAML: normalized.NormalizedYAML,
			Digest:         normalized.Digest,
			Summary:        normalized.Summary,
		}
	}
	create := func(in wfstore.CreateInput) slugRaceOutcome {
		wf, _, err := store.Create(ctx, scope, in)
		if err == nil {
			return slugRaceOutcome{slug: wf.Slug, status: http.StatusCreated}
		}
		rec := httptest.NewRecorder()
		WriteWorkflowStoreError(rec, httptest.NewRequest(http.MethodPost, "/api/v1/workflows", nil), err)
		var p core.Problem
		if jerr := json.Unmarshal(rec.Body.Bytes(), &p); jerr != nil {
			t.Errorf("problem body for %v: %v", err, jerr)
		}
		return slugRaceOutcome{status: rec.Code, problem: p}
	}
	assertSlug409 := func(t *testing.T, o slugRaceOutcome, codes ...string) {
		t.Helper()
		if o.status != http.StatusConflict {
			t.Fatalf("status = %d problem %+v", o.status, o.problem)
		}
		ok := false
		for _, c := range codes {
			ok = ok || o.problem.Code == c
		}
		if !ok || o.problem.Code == core.CodeConflict {
			t.Fatalf("code = %q", o.problem.Code)
		}
		if len(o.problem.Errors) != 1 || o.problem.Errors[0].Path != "slug" || o.problem.Errors[0].Code != o.problem.Code {
			t.Fatalf("errors = %+v", o.problem.Errors)
		}
	}

	// Some of the family is already held by deleted workflows.
	for i := 0; i < 3; i++ {
		o := create(input("burst", true))
		if o.status != http.StatusCreated {
			t.Fatalf("seed create = %+v", o)
		}
		got, err := store.List(ctx, scope, wfstore.WorkflowListFilter{})
		if err != nil {
			t.Fatal(err)
		}
		for _, wf := range got {
			if wf.Slug == o.slug && i != 1 {
				if _, err := store.Delete(ctx, scope, wf.ID); err != nil {
					t.Fatal(err)
				}
			}
		}
	}

	const workers = 24
	var wg sync.WaitGroup
	start := make(chan struct{})
	derived := make([]slugRaceOutcome, workers)
	explicit := make([]slugRaceOutcome, workers)
	for i := 0; i < workers; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			<-start
			derived[i] = create(input("burst", true))
		}(i)
		go func(i int) {
			defer wg.Done()
			<-start
			explicit[i] = create(input("burst-explicit", false))
		}(i)
	}
	close(start)
	wg.Wait()

	seen := map[string]bool{}
	for i, o := range derived {
		if o.status != http.StatusCreated {
			t.Fatalf("name-only create %d = %d %+v, want 201 with no client retry", i, o.status, o.problem)
		}
		if seen[o.slug] {
			t.Fatalf("duplicate derived slug %q", o.slug)
		}
		seen[o.slug] = true
	}
	if len(seen) != workers {
		t.Fatalf("distinct derived slugs = %d", len(seen))
	}
	// The seed used burst..burst-3; the burst takes exactly burst-4..burst-27.
	for n := 4; n < workers+4; n++ {
		if !seen[fmt.Sprintf("burst-%d", n)] {
			t.Fatalf("derived slugs skipped burst-%d: %v", n, seen)
		}
	}

	wins := 0
	for _, o := range explicit {
		if o.status == http.StatusCreated {
			wins++
			if o.slug != "burst-explicit" {
				t.Fatalf("explicit slug rewritten to %q", o.slug)
			}
			continue
		}
		assertSlug409(t, o, core.CodeWorkflowSlugTaken)
		if o.problem.SuggestedSlug == "" || o.problem.SuggestedSlug == "burst-explicit" {
			t.Fatalf("suggestedSlug = %q", o.problem.SuggestedSlug)
		}
	}
	if wins != 1 {
		t.Fatalf("explicit wins = %d", wins)
	}

	// A deleted holder is reserved, with a suggestion past every used suffix.
	o := create(input("burst", false))
	assertSlug409(t, o, core.CodeWorkflowSlugReserved)
	if o.problem.SuggestedSlug != fmt.Sprintf("burst-%d", workers+4) {
		t.Fatalf("reserved suggestedSlug = %q", o.problem.SuggestedSlug)
	}
	t.Logf("derived creates: %d, all 201 with no client retry", workers)
}
