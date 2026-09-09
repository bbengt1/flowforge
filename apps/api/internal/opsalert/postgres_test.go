package opsalert

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestPostgresAuditAppendOnlyAndAlerts(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
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

	wfStore := wfstore.NewPostgres(app)
	alerts := NewPostgres(app)
	wsA, wsB, userID := seedAlertWorkspaces(t, ctx, admin)
	scopeA, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}

	ev, err := wfStore.WriteAudit(ctx, scopeA, wfstore.AuditWrite{
		Action:       "execution.started",
		ResourceType: "execution",
		Outcome:      "allowed",
		Details:      map[string]any{"token": "super-secret-token"},
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("app role cannot update audit events", func(t *testing.T) {
		tx, err := postgres.BeginScoped(ctx, app, wsA)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, err = tx.Exec(ctx, `UPDATE audit_events SET outcome = 'tampered' WHERE id = $1::uuid`, ev.ID)
		if err == nil {
			t.Fatal("expected update to fail")
		}
	})

	t.Run("app role cannot delete live audit events", func(t *testing.T) {
		tx, err := postgres.BeginScoped(ctx, app, wsA)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, err = tx.Exec(ctx, `DELETE FROM audit_events WHERE id = $1::uuid`, ev.ID)
		if err == nil {
			t.Fatal("expected delete to fail")
		}
		got, err := wfStore.ListAuditEvents(ctx, scopeA, wfstore.AuditListFilter{Action: "execution.started"})
		if err != nil || len(got) == 0 {
			t.Fatalf("row missing after denied delete: %v %#v", err, got)
		}
	})

	t.Run("expired audit purge uses definer and leaves live rows", func(t *testing.T) {
		tx, err := admin.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SELECT app.set_workspace_id($1::uuid)`, wsA); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO audit_events (workspace_id, action, resource_type, outcome, occurred_at, retention_until)
			VALUES ($1::uuid, 'retention.test', 'execution', 'allowed', now() - interval '400 days', now() - interval '1 day')
		`, wsA); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		execs, audits, err := wfStore.PurgeExpired(ctx, scopeA, time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
		if audits < 1 {
			t.Fatalf("purged audits=%d execs=%d, want at least 1 audit", audits, execs)
		}
		live, err := wfStore.ListAuditEvents(ctx, scopeA, wfstore.AuditListFilter{Action: "execution.started"})
		if err != nil || len(live) == 0 {
			t.Fatalf("live audit removed: %v %#v", err, live)
		}
	})

	t.Run("alerts keep identifiers and isolate workspaces", func(t *testing.T) {
		alert, err := alerts.Emit(ctx, scopeA, Signal{
			Kind:          KindAuthorization,
			Action:        "workflow.execute",
			ResourceType:  "workspace",
			ResourceID:    wsA,
			CorrelationID: "corr-pg-e54",
			RequestID:     "req-pg-e54",
			Code:          "forbidden",
			Details: map[string]any{
				"token":       "super-secret-token",
				"executionId": ev.ID,
				"reason":      "missing-permission",
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if alert.ResourceID != wsA || alert.Details["token"] != nil {
			t.Fatalf("persisted secrets or wrong id: %+v details=%#v", alert, alert.Details)
		}
		if _, err := alerts.Get(ctx, scopeB, alert.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-workspace get: %v", err)
		}
		listed, err := alerts.List(ctx, scopeB, ListFilter{})
		if err != nil || len(listed) != 0 {
			t.Fatalf("cross-workspace list: %v %#v", err, listed)
		}
		acked, err := alerts.Ack(ctx, scopeA, alert.ID)
		if err != nil || acked.AcknowledgedAt == nil {
			t.Fatalf("ack: %v %+v", err, acked)
		}
	})
}

func seedAlertWorkspaces(t *testing.T, ctx context.Context, db identity.DB) (string, string, string) {
	t.Helper()
	store := identity.NewPostgres(db)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	tenant, err := store.CreateTenant(ctx, "al-"+suffix[len(suffix)-12:], "AL")
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUser(ctx, "https://idp.example", "al-"+suffix, "AL")
	if err != nil {
		t.Fatal(err)
	}
	a, err := store.CreateWorkspace(ctx, tenant.ID, "bench-a-"+suffix[len(suffix)-8:], "A", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := store.CreateWorkspace(ctx, tenant.ID, "bench-b-"+suffix[len(suffix)-8:], "B", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	return a.ID, b.ID, user.ID
}
