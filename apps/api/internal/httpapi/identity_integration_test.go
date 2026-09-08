package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestIdentityAPIAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	store := identity.NewPostgres(pool)
	h := httpapi.NewWithStore(nil, store)
	n := time.Now().UnixNano()
	slug := fmt.Sprintf("org%d", n)
	workbench := fmt.Sprintf("wb%d", n)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader([]byte(`{"slug":"`+slug+`","name":"Org"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", "pg-admin")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/workspaces", bytes.NewReader([]byte(`{"tenant_slug":"`+slug+`","workbench_key":"`+workbench+`","name":"WB"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", "pg-admin")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/workspaces", bytes.NewReader([]byte(`{"tenant_slug":"`+slug+`","workbench_key":"`+workbench+`","name":"WB2"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", "pg-admin")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate workspace status = %d body=%s", rec.Code, rec.Body.String())
	}
	var p httpapi.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Code != httpapi.CodeConflict {
		t.Fatalf("code = %q", p.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", "pg-admin")
	req.Header.Set("X-FlowForge-Workspace-ID", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("host-supplied workspace id status = %d body=%s", rec.Code, rec.Body.String())
	}
}
