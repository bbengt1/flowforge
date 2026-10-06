package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// A version published before #557 can carry a stale metadata.slug.
// Restoring it is a draft write: the stored slug goes back into the draft,
// slug_immutable is never returned, and the next export carries the stored
// slug. The old version row is not rewritten.
func TestRestoreStaleVersionExportsStoredSlugAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	n := time.Now().UnixNano()
	user := identity.User{Issuer: "https://idp.example", ExternalSubject: fmt.Sprintf("restore-slug-%d", n), DisplayName: "Admin"}
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:          identity.NewPostgres(pool),
		Scoped:         isolation.NewPostgres(pool),
		Workflows:      wfstore.NewPostgres(pool),
		PlatformAdmins: []authz.PrincipalRef{{Issuer: user.Issuer, Subject: user.ExternalSubject}},
	}))
	tenantSlug := fmt.Sprintf("rs%d", n%1_000_000_000_000)
	var tenant identity.Tenant
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"`+tenantSlug+`","name":"Restore"}`, user))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &tenant); err != nil {
		t.Fatal(err)
	}
	var ws identity.Workspace
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"`+tenantSlug+`","workbench_key":"ops","name":"Ops"}`, user))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ws); err != nil {
		t.Fatal(err)
	}

	created := postWorkflow(t, h, user, tenant, ws, map[string]string{"definitionYaml": slugHTTPYAML("blank-draft", ""), "name": "Restore Stale"}, http.StatusCreated)
	if created.Workflow.Slug != "restore-stale" {
		t.Fatalf("slug = %q", created.Workflow.Slug)
	}
	// Build the pre-#557 drift directly: a normalized draft whose
	// metadata.slug differs from the stored slug.
	doc, errs := workflow.Parse([]byte(created.Draft.DefinitionYAML))
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	doc.Metadata.Slug = "restore-stale-old"
	staleYAML, staleDigest, err := workflow.Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `UPDATE workflow_drafts SET normalized_yaml = $2, definition_digest = $3 WHERE workflow_id = $1::uuid`,
		created.Workflow.ID, staleYAML, staleDigest); err != nil {
		t.Fatal(err)
	}
	v1 := publishWorkflow(t, h, user, tenant, ws, created.Workflow.ID, created.Draft.Revision, "stale")
	if !strings.Contains(exportVersionYAML(t, h, user, tenant, ws, created.Workflow.ID, v1.Version.ID), "slug: restore-stale-old") {
		t.Fatal("v1 export should keep its stale slug")
	}

	rec = httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"expectedRevision": created.Draft.Revision})
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/versions/"+v1.Version.ID+"/restore", body, user, tenant, ws))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
	}
	var restored workflowDetailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &restored); err != nil {
		t.Fatal(err)
	}
	assertDraftSlug(t, restored.Draft.DefinitionYAML, "restore-stale")
	if workflow.Digest(restored.Draft.DefinitionYAML) != restored.Draft.Digest {
		t.Fatal("restored digest does not match yaml")
	}

	v2 := publishWorkflow(t, h, user, tenant, ws, created.Workflow.ID, restored.Draft.Revision, "restored")
	exported := exportVersionYAML(t, h, user, tenant, ws, created.Workflow.ID, v2.Version.ID)
	assertDraftSlug(t, exported, "restore-stale")
	if strings.Contains(exportVersionYAML(t, h, user, tenant, ws, created.Workflow.ID, v1.Version.ID), "slug: restore-stale\n") {
		t.Fatal("v1 export was rewritten")
	}
}

func exportVersionYAML(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, workflowID, versionID string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/workflows/"+workflowID+"/versions/"+versionID+"/export", nil, user, tenant, ws))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	var exp exportResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &exp); err != nil {
		t.Fatal(err)
	}
	return exp.DefinitionYAML
}
