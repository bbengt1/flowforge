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
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestSessionAPIAgainstPostgres(t *testing.T) {
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
	sessions := session.NewPostgres(pool)
	h := httpapi.NewWithDeps(httpapi.Deps{
		Store:    store,
		Sessions: sessions,
		Security: httpapi.Security{TrustIdentityHeaders: true},
	})
	n := time.Now().UnixNano()
	subject := fmt.Sprintf("sess-admin-%d", n)

	body := []byte(`{"issuer":"https://idp.example","external_subject":"` + subject + `","display_name":"Admin"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/session", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create session: %d %s", rec.Code, rec.Body.String())
	}

	var token, csrf string
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case session.CookieName:
			token = c.Value
		case session.CSRFCookieName:
			csrf = c.Value
		}
	}
	if token == "" || csrf == "" {
		t.Fatal("expected session cookies")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get session: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/session/refresh", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
	req.Header.Set(session.CSRFHeader, csrf)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case session.CookieName:
			token = c.Value
		case session.CSRFCookieName:
			csrf = c.Value
		}
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/tenants", bytes.NewReader([]byte(`{"slug":"`+fmt.Sprintf("s%d", n)+`","name":"S"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	req.Header.Set(session.CSRFHeader, "wrong")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("csrf fail-closed: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/session/logout", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
	req.Header.Set(session.CSRFHeader, csrf)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var p httpapi.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusUnauthorized || p.Code != httpapi.CodeUnauthenticated {
		t.Fatalf("revoked session: %d %+v", rec.Code, p)
	}
}
