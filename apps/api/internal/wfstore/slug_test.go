package wfstore

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
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
	cands, err := slugCandidates(SlugChoice{Slug: "catalog", Derived: true})
	if err != nil || len(cands) == 0 || cands[0] != "catalog-2" {
		t.Fatalf("reserved candidates = %v %v", cands, err)
	}
	long, ok := workflowSlugCandidate(strings.Repeat("a", 63), 2)
	if !ok || len(long) > 63 || strings.HasSuffix(long, "-") || !strings.HasSuffix(long, "-2") {
		t.Fatalf("capped suffix = %q", long)
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
