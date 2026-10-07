package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// TestWorkspaceGroupsAPIAgainstPostgres drives the group routes over the
// Postgres store: the concurrent create race answers 409
// group_name_taken (never 500 or conflict), and each change writes its
// audit row with the request id.
func TestWorkspaceGroupsAPIAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
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

	store := identity.NewPostgres(pool)
	n := time.Now().UnixNano()
	slug := fmt.Sprintf("grp%d", n)
	workbench := fmt.Sprintf("gwb%d", n)
	subject := fmt.Sprintf("grp-admin-%d", n)
	h := httpapi.NewWithDeps(httpapi.Deps{
		Store:          store,
		Security:       httpapi.Security{TrustIdentityHeaders: true},
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: subject}},
	})
	call := func(method, path, body, requestID string) *httptest.ResponseRecorder {
		var req *http.Request
		if body == "" {
			req = httptest.NewRequest(method, path, nil)
		} else {
			req = httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
		req.Header.Set("X-FlowForge-Subject", subject)
		req.Header.Set("X-FlowForge-Tenant-Slug", slug)
		req.Header.Set("X-FlowForge-Workbench-Key", workbench)
		req.Header.Set("X-Request-ID", requestID)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := call(http.MethodPost, "/api/v1/tenants", `{"slug":"`+slug+`","name":"Org"}`, "grp-request-0000001"); rec.Code != http.StatusCreated {
		t.Fatalf("tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec := call(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"`+slug+`","workbench_key":"`+workbench+`","name":"WB"}`, "grp-request-0000002")
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace: %d %s", rec.Code, rec.Body.String())
	}
	var ws identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &ws); err != nil {
		t.Fatal(err)
	}

	const racers = 8
	codes := make([]int, racers)
	bodies := make([]string, racers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			name := "On-Call Approvers"
			if i%2 == 1 {
				name = "ON-CALL approvers"
			}
			r := call(http.MethodPost, "/api/v1/workspace/groups", `{"displayName":"`+name+`"}`, fmt.Sprintf("grp-race-%011d", i))
			codes[i], bodies[i] = r.Code, r.Body.String()
		}(i)
	}
	close(start)
	wg.Wait()
	created := ""
	for i, code := range codes {
		switch code {
		case http.StatusCreated:
			if created != "" {
				t.Fatal("two racers created the same name")
			}
			var g identity.Group
			if err := json.Unmarshal([]byte(bodies[i]), &g); err != nil {
				t.Fatal(err)
			}
			created = g.ID
		case http.StatusConflict:
			var p httpapi.Problem
			if err := json.Unmarshal([]byte(bodies[i]), &p); err != nil {
				t.Fatal(err)
			}
			if p.Code != httpapi.CodeGroupNameTaken || len(p.Errors) != 1 || p.Errors[0].Path != "displayName" {
				t.Fatalf("racer %d problem %+v", i, p)
			}
		default:
			t.Fatalf("racer %d: %d %s", i, code, bodies[i])
		}
	}
	if created == "" {
		t.Fatal("no racer created the group")
	}

	var adminID string
	if err := admin.QueryRow(ctx, `SELECT id::text FROM users WHERE external_subject = $1`, subject).Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	if rec := call(http.MethodPost, "/api/v1/workspace/groups/"+created+"/members", `{"userId":"`+adminID+`"}`, "grp-request-0000003"); rec.Code != http.StatusNoContent {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodGet, "/api/v1/workspace/groups/"+created, "", "grp-request-0000004")
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	var d identity.GroupDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if len(d.Members) != 1 || d.Members[0].UserID != adminID || !d.Members[0].CanApprove {
		t.Fatalf("detail %+v", d)
	}
	if rec := call(http.MethodDelete, "/api/v1/workspace/groups/"+created, "", "grp-request-0000005"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}

	rows, err := admin.Query(ctx, `
		SELECT action, COALESCE(correlation_id, '') FROM audit_events
		WHERE workspace_id = $1 AND resource_type = 'workspace_group' AND resource_id = $2
		ORDER BY occurred_at`, ws.ID, created)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]string{}
	for rows.Next() {
		var action, corr string
		if err := rows.Scan(&action, &corr); err != nil {
			t.Fatal(err)
		}
		got[action] = corr
	}
	if len(got) != 3 || got["workspace_group.member_add"] != "grp-request-0000003" || got["workspace_group.delete"] != "grp-request-0000005" || got["workspace_group.create"] == "" {
		t.Fatalf("audit rows = %v", got)
	}
}
