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
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestIsolationAPIAgainstPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	store := identity.NewPostgres(pool)
	h := httpapi.NewWithStores(nil, store, isolation.NewPostgres(pool))
	n := time.Now().UnixNano()
	slug := fmt.Sprintf("iso%d", n)
	subject := fmt.Sprintf("iso-admin-%d", n)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader([]byte(`{"slug":"`+slug+`","name":"Iso"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", subject)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/workspaces", bytes.NewReader([]byte(`{"tenant_slug":"`+slug+`","workbench_key":"a","name":"A"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", subject)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace A: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/workspaces", bytes.NewReader([]byte(`{"tenant_slug":"`+slug+`","workbench_key":"b","name":"B"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", subject)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace B: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/workspace/records", bytes.NewReader([]byte(`{"kind":"credential","name":"k8s"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", subject)
	req.Header.Set("X-FlowForge-Tenant-Slug", slug)
	req.Header.Set("X-FlowForge-Workbench-Key", "a")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create credential: %d %s", rec.Code, rec.Body.String())
	}
	var cred isolation.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &cred); err != nil {
		t.Fatal(err)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/workspace/credentials/"+cred.ID+"/use", nil)
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", subject)
	req.Header.Set("X-FlowForge-Tenant-Slug", slug)
	req.Header.Set("X-FlowForge-Workbench-Key", "b")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace credential use = %d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/workspace/records?kind=credential", nil)
	req.Header.Set("X-FlowForge-Issuer", "https://idp.example")
	req.Header.Set("X-FlowForge-Subject", subject)
	req.Header.Set("X-FlowForge-Tenant-Slug", slug)
	req.Header.Set("X-FlowForge-Workbench-Key", "b")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list B: %d %s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Items []isolation.Record `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 0 {
		t.Fatalf("workspace B listed %d credentials from A", len(listed.Items))
	}
}
