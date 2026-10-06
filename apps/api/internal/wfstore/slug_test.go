package wfstore

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestSlugifyWorkflowName(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{name: "Deploy API", want: "deploy-api"},
		{name: "restart-api-rollout", want: "restart-api-rollout"},
		{name: "O'Reilly (prod) #2", want: "o-reilly-prod-2"},
		{name: "9 lives", want: "w-9-lives"},
		{name: "!!!", want: "workflow"},
		{name: "  ", want: "workflow"},
		{name: "部署", want: "workflow"},
	}
	for _, tc := range cases {
		got := slugifyWorkflowName(tc.name)
		if got != tc.want {
			t.Fatalf("slugify %q = %q, want %q", tc.name, got, tc.want)
		}
		if !validDerivedWorkflowSlug(got) || !authz.ValidTenantSlug(got) {
			t.Fatalf("slugify %q produced invalid slug %q", tc.name, got)
		}
	}
	long := strings.Repeat("A", 80) + " " + strings.Repeat("B", 80)
	got := slugifyWorkflowName(long)
	if !validDerivedWorkflowSlug(got) || len(got) > 63 || strings.HasSuffix(got, "-") {
		t.Fatalf("long title slug = %q", got)
	}
	choice, err := ChooseCreateSlug("keep-me", "yaml-slug", "Deploy API")
	if err != nil || choice.Derived || choice.Slug != "keep-me" {
		t.Fatalf("body slug = %+v %v", choice, err)
	}
	choice, err = ChooseCreateSlug("", "yaml-slug", "Deploy API")
	if err != nil || choice.Derived || choice.Slug != "yaml-slug" {
		t.Fatalf("yaml slug = %+v %v", choice, err)
	}
	choice, err = ChooseCreateSlug("", "", "Deploy API")
	if err != nil || !choice.Derived || choice.Slug != "deploy-api" {
		t.Fatalf("derived slug = %+v %v", choice, err)
	}
	choice, err = ChooseCreateSlug("", "", "🎉")
	if err != nil || !choice.Derived || choice.Slug != "workflow" {
		t.Fatalf("emoji slug = %+v %v", choice, err)
	}
	choice, err = ChooseCreateSlug("", "", "Catalog")
	if err != nil || !choice.Derived || choice.Slug != "catalog" {
		t.Fatalf("reserved base = %+v %v", choice, err)
	}
	if _, err := ChooseCreateSlug("catalog", "", "Deploy API"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("explicit reserved = %v", err)
	}
	if next, ok := nextDerivedSlug("catalog", nil); !ok || next != "catalog-2" {
		t.Fatalf("reserved base next = %q %v", next, ok)
	}
	long, ok := workflowSlugCandidate(strings.Repeat("a", 63), 2)
	if !ok || long != strings.Repeat("a", 61)+"-2" || len(long) > 63 || !validDerivedWorkflowSlug(long) {
		t.Fatalf("capped suffix = %q", long)
	}
	cut := strings.Repeat("b", 60) + "-cd"
	got, ok = workflowSlugCandidate(cut, 2)
	if !ok || got != strings.Repeat("b", 60)+"-2" || strings.Contains(got, "--") || !validDerivedWorkflowSlug(got) {
		t.Fatalf("hyphen cut suffix = %q", got)
	}
}

func TestNewWorkflowSlugValidator(t *testing.T) {
	for _, slug := range []string{"qa-546-trail-", "double--hyphen", "-lead", "catalog", "Upper", ""} {
		if workflow.ValidNewWorkflowSlug(slug) {
			t.Fatalf("new slug %q accepted", slug)
		}
		if _, err := ChooseCreateSlug(slug, "", "Name"); slug != "" && !errors.Is(err, ErrInvalid) {
			t.Fatalf("explicit %q = %v", slug, err)
		}
	}
	for _, slug := range []string{"a", "deploy-api", "w-9-lives", "x-2-3"} {
		if !workflow.ValidNewWorkflowSlug(slug) {
			t.Fatalf("new slug %q rejected", slug)
		}
	}
	// Legacy stored slugs stay valid for YAML validation, save, and export.
	for _, slug := range []string{"qa-546-trail-", "double--hyphen"} {
		if !workflow.ValidWorkflowSlug(slug) {
			t.Fatalf("legacy slug %q no longer valid for YAML", slug)
		}
	}
}

func TestSlugSuffixMatchIsExact(t *testing.T) {
	cases := []struct {
		base, slug string
		n          int
		ok         bool
	}{
		{"x", "x", 1, true},
		{"x", "x-2", 2, true},
		{"x", "x-10", 10, true},
		{"x", "x-2-3", 0, false},
		{"x-2", "x-2-3", 3, true},
		{"x-2", "x-2", 1, true},
		{"x", "x-02", 0, false},
		{"x", "x-1", 0, false},
		{"x", "x-", 0, false},
		{"x", "xy-2", 0, false},
		{"x", "x_2", 0, false},
		{"x", "x-ray-2", 0, false},
		{"x", "x-1234567890", 0, false},
		{strings.Repeat("a", 63), strings.Repeat("a", 61) + "-2", 2, true},
		{strings.Repeat("a", 63), strings.Repeat("a", 60) + "-10", 10, true},
		{strings.Repeat("a", 63), strings.Repeat("a", 61) + "-10", 0, false},
	}
	for _, tc := range cases {
		n, ok := slugSuffixFor(tc.base, tc.slug)
		if n != tc.n || ok != tc.ok {
			t.Fatalf("slugSuffixFor(%q, %q) = %d %v, want %d %v", tc.base, tc.slug, n, ok, tc.n, tc.ok)
		}
		if tc.ok && !strings.HasPrefix(tc.slug, slugMatchPrefix(tc.base)) {
			t.Fatalf("prefix %q does not cover %q", slugMatchPrefix(tc.base), tc.slug)
		}
	}
}

func TestNextDerivedSlugTakesHighestPlusOne(t *testing.T) {
	cases := []struct {
		base string
		used []string
		want string
	}{
		{"x", nil, "x"},
		{"x", []string{"x"}, "x-2"},
		{"x", []string{"x", "x-2", "x-7"}, "x-8"},
		{"x", []string{"x-2"}, "x-3"},
		{"x", []string{"x", "x-2-3", "x_9", "xx-40"}, "x-2"},
		{"x-2", []string{"x", "x-2", "x-2-3"}, "x-2-4"},
		{"catalog", nil, "catalog-2"},
		{"catalog", []string{"catalog-2"}, "catalog-3"},
		{strings.Repeat("a", 63), []string{strings.Repeat("a", 63), strings.Repeat("a", 61) + "-9"}, strings.Repeat("a", 60) + "-10"},
	}
	for _, tc := range cases {
		got, ok := nextDerivedSlug(tc.base, tc.used)
		if !ok || got != tc.want {
			t.Fatalf("nextDerivedSlug(%q, %v) = %q %v, want %q", tc.base, tc.used, got, ok, tc.want)
		}
		if !workflow.ValidNewWorkflowSlug(got) || len(got) > maxWorkflowSlugLen {
			t.Fatalf("next slug %q is not a valid new slug", got)
		}
	}
	if _, ok := nextDerivedSlug("bad-", nil); ok {
		t.Fatal("trailing-hyphen base produced a slug")
	}
}

func TestSuggestSlugFromClashingSlug(t *testing.T) {
	cases := []struct {
		slug string
		used []string
		want string
	}{
		{"orders", []string{"orders"}, "orders-2"},
		{"orders", []string{"orders", "orders-2", "orders-5"}, "orders-6"},
		{"orders-2", []string{"orders", "orders-2"}, "orders-3"},
		{"x-2-3", []string{"x-2-3"}, "x-2-4"},
		{"release-2026", []string{"release-2026"}, "release-2027"},
	}
	for _, tc := range cases {
		if got := suggestSlug(tc.slug, tc.used); got != tc.want {
			t.Fatalf("suggestSlug(%q, %v) = %q, want %q", tc.slug, tc.used, got, tc.want)
		}
	}
}

func TestDraftSlugForSave(t *testing.T) {
	cases := []struct {
		stored, previous, incoming string
		ok                         bool
	}{
		{"orders", "orders", "orders", true},
		{"orders", "orders", "", true},
		{"orders", "drifted", "drifted", true},
		{"orders", "drifted", "orders", true},
		{"orders", "", "", true},
		{"orders", "orders", "other", false},
		{"orders", "drifted", "other", false},
		{"orders", "", "other", false},
		{"qa-546-trail-", "qa-546-trail-", "qa-546-trail-", true},
	}
	for _, tc := range cases {
		err := draftSlugForSave(tc.stored, tc.previous, tc.incoming)
		if (err == nil) != tc.ok || (err != nil && !errors.Is(err, ErrSlugImmutable)) {
			t.Fatalf("draftSlugForSave(%q, %q, %q) = %v", tc.stored, tc.previous, tc.incoming, err)
		}
	}
}

func TestWorkflowSlugUniqueMatchesConstraintName(t *testing.T) {
	slugErr := &pgconn.PgError{Code: "23505", ConstraintName: "workflows_slug_unique"}
	if !workflowSlugUnique(slugErr) {
		t.Fatal("workflows_slug_unique was not detected")
	}
	other := &pgconn.PgError{Code: "23505", ConstraintName: "execution_steps_attempt_unique"}
	if workflowSlugUnique(other) {
		t.Fatal("another unique constraint was treated as a slug clash")
	}
	if workflowSlugUnique(ErrConstraint) || workflowSlugUnique(ErrConflict) {
		t.Fatal("mapped unique errors were treated as a slug clash")
	}
}

func TestMemoryCreateDerivesSlugFromDisplayName(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := testWorkflowScope(t)
	assertCreateDerivesDisplaySlug(t, ctx, store, scope)
}

func TestPostgresCreateDerivesSlugFromDisplayName(t *testing.T) {
	ctx := context.Background()
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
	mem := NewMemory()
	memWF, _, err := mem.Create(ctx, scope, displayNameCreateInput(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	pgWF, _, err := store.Create(ctx, scope, displayNameCreateInput(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	if pgWF.Slug != memWF.Slug || pgWF.Name != memWF.Name {
		t.Fatalf("stores disagree: postgres slug=%q name=%q memory slug=%q name=%q", pgWF.Slug, pgWF.Name, memWF.Slug, memWF.Name)
	}
	if pgWF.Slug != "deploy-api" || pgWF.Name != "Deploy API" {
		t.Fatalf("postgres create = slug %q name %q", pgWF.Slug, pgWF.Name)
	}
}

func assertCreateDerivesDisplaySlug(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) {
	t.Helper()
	wf, _, err := store.Create(ctx, scope, displayNameCreateInput(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	if wf.Name != "Deploy API" || wf.Slug != "deploy-api" {
		t.Fatalf("create = name %q slug %q", wf.Name, wf.Slug)
	}
	if !validDerivedWorkflowSlug(wf.Slug) || !authz.ValidTenantSlug(wf.Slug) {
		t.Fatalf("derived slug %q is not a DNS label", wf.Slug)
	}

	explicit, _, err := store.Create(ctx, scope, displayNameCreateInput(t, "custom-slug"))
	if err != nil {
		t.Fatal(err)
	}
	if explicit.Slug != "custom-slug" || explicit.Name != "Deploy API" {
		t.Fatalf("explicit slug create = name %q slug %q", explicit.Name, explicit.Slug)
	}

	renamedYAML := strings.Replace(displayNameYAML, "name: Deploy API", "name: Renamed Title", 1)
	renamed := mustNormalize(t, renamedYAML)
	saved, _, err := store.SaveDraft(ctx, scope, wf.ID, SaveInput{
		ExpectedRevision: 1,
		NormalizedYAML:   renamed.NormalizedYAML,
		Digest:           renamed.Digest,
		Summary:          renamed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Slug != "deploy-api" || saved.Name != "Renamed Title" {
		t.Fatalf("draft rename = name %q slug %q", saved.Name, saved.Slug)
	}
}

const displayNameYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: Deploy API
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: kubernetes.apply
      name: Restart API
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
  edges: []
`

func displayNameCreateInput(t *testing.T, slug string) CreateInput {
	t.Helper()
	normalized := mustNormalize(t, displayNameYAML)
	if normalized.Summary.Name != "Deploy API" {
		t.Fatalf("summary name = %q", normalized.Summary.Name)
	}
	return CreateInput{
		Slug:           slug,
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	}
}

func testWorkflowScope(t *testing.T) isolation.Scope {
	t.Helper()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	return scope
}
