package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestWorkflowKeysetPaginationAndSearch(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	slugs := []string{"page-alpha", "page-bravo", "page-charlie", "page-delta", "page-echo"}
	want := map[string]string{}
	for _, slug := range slugs {
		yamlSrc := strings.Replace(validWorkflowYAML, "name: restart-api-rollout", "name: "+slug, 1)
		body, _ := json.Marshal(map[string]string{"definitionYaml": yamlSrc, "slug": slug})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create %s: %d %s", slug, rec.Code, rec.Body.String())
		}
		var created workflowDetailResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
			t.Fatal(err)
		}
		want[created.Workflow.ID] = slug
	}

	seen := map[string]int{}
	cursor := ""
	var firstNext string
	var secondIDs []string
	for pageN := 1; pageN <= 6; pageN++ {
		path := "/api/v1/workflows?limit=2"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		page := getWorkflowPage(t, h, admin, tenant, ws, path)
		if page.Limit != 2 {
			t.Fatalf("limit = %d", page.Limit)
		}
		if page.Cursor != cursor {
			t.Fatalf("cursor echo = %q, want %q", page.Cursor, cursor)
		}
		if pageN == 1 && page.Next == "" {
			t.Fatal("first page next is empty")
		}
		if pageN == 1 {
			firstNext = page.Next
		}
		if pageN == 2 {
			for _, item := range page.Items {
				secondIDs = append(secondIDs, item.ID)
			}
		}
		for _, item := range page.Items {
			seen[item.ID]++
		}
		if page.Next == "" {
			if pageN < 3 {
				t.Fatalf("ended on page %d before all rows", pageN)
			}
			break
		}
		cursor = page.Next
	}
	if len(seen) != len(want) {
		t.Fatalf("walked %d workflows, want %d", len(seen), len(want))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("id %s seen %d times", id, n)
		}
		if _, ok := want[id]; !ok {
			t.Fatalf("unexpected id %s", id)
		}
	}

	again := getWorkflowPage(t, h, admin, tenant, ws, "/api/v1/workflows?limit=2&cursor="+url.QueryEscape(firstNext))
	if len(again.Items) != len(secondIDs) {
		t.Fatalf("stable page len %d, want %d", len(again.Items), len(secondIDs))
	}
	for i, item := range again.Items {
		if item.ID != secondIDs[i] {
			t.Fatalf("cursor not stable at %d: %s vs %s", i, item.ID, secondIDs[i])
		}
	}

	found := getWorkflowPage(t, h, admin, tenant, ws, "/api/v1/workflows?q=page-charlie")
	if len(found.Items) != 1 || found.Items[0].Slug != "page-charlie" {
		t.Fatalf("search = %+v", found.Items)
	}
	if found.Next != "" {
		t.Fatalf("search next = %q", found.Next)
	}
	if found.Limit != 50 {
		t.Fatalf("default limit = %d", found.Limit)
	}

	for _, path := range []string{
		"/api/v1/workflows?limit=0",
		"/api/v1/workflows?limit=101",
		"/api/v1/workflows?cursor=not-a-cursor",
		"/api/v1/workflows?q=" + url.QueryEscape("bad\nquery"),
	} {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, path, nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "not-a-cursor") || strings.Contains(rec.Body.String(), "bad\nquery") {
			t.Fatalf("problem echoed query: %s", rec.Body.String())
		}
	}
}

func TestCredentialSearchIgnoresSecret(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	createVaultCredential(t, h, admin, tenant, ws, "token", "PagerDuty", map[string]string{"token": vaultPlaintext})

	secretRec := httptest.NewRecorder()
	secretReq := workspaceRequest(http.MethodGet, "/api/v1/credentials?q="+url.QueryEscape(vaultPlaintext), nil, admin, tenant, ws)
	h.ServeHTTP(secretRec, secretReq)
	if secretRec.Code != http.StatusOK {
		t.Fatalf("secret search: %d %s", secretRec.Code, secretRec.Body.String())
	}
	var secretPage pageResponse[vault.Metadata]
	if err := json.Unmarshal(secretRec.Body.Bytes(), &secretPage); err != nil {
		t.Fatal(err)
	}
	if len(secretPage.Items) != 0 || secretPage.Next != "" {
		t.Fatalf("secret search = %+v next %q", secretPage.Items, secretPage.Next)
	}
	if strings.Contains(secretRec.Body.String(), vaultPlaintext) {
		t.Fatal("secret search body contained plaintext")
	}

	namePage := getCredentialPage(t, h, admin, tenant, ws, "/api/v1/credentials?q=pager")
	if len(namePage.Items) != 1 || namePage.Items[0].DisplayName != "PagerDuty" {
		t.Fatalf("name search = %+v", namePage.Items)
	}

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/credentials?limit=101&q="+url.QueryEscape(vaultPlaintext), nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	if strings.Contains(rec.Body.String(), vaultPlaintext) || strings.Contains(rec.Body.String(), "101") {
		t.Fatalf("problem echoed query: %s", rec.Body.String())
	}
}

func getWorkflowPage(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, path string) pageResponse[wfstore.Workflow] {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, path, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body.String())
	}
	var out pageResponse[wfstore.Workflow]
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Items == nil {
		t.Fatal("items is null")
	}
	return out
}

func getCredentialPage(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, path string) pageResponse[vault.Metadata] {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, path, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body.String())
	}
	var out pageResponse[vault.Metadata]
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
