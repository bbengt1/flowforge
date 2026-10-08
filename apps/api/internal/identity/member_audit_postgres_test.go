package identity

import (
	"context"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// A system path (the dev-only local seed) records via=system and no
// actor_id; a later no-op writes nothing.
func TestPostgresSystemMemberRoleChangeIsAudited(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := NewPostgres(pool)
	suffix := newID()[:8]
	tenant, err := store.CreateTenant(ctx, "ta-"+suffix, "Tenant "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := store.UpsertUser(ctx, "https://idp.example", "own-"+suffix, "Owner")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(ctx, tenant.ID, "aud-"+suffix, "Aud", owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	u, err := store.UpsertUser(ctx, "https://idp.example", "sys-"+suffix, "Seeded")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := store.SetMemberRoles(ctx, ws.ID, u.ID, []string{"viewer"}, MemberActor{Via: MemberViaSystem}); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT app.set_workspace_id($1::uuid)`, ws.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	var actor, via, after string
	if err := tx.QueryRow(ctx, `
		SELECT count(*) OVER (), COALESCE(actor_id::text, ''), COALESCE(details_redacted->>'via', ''), details_redacted->>'rolesAfter'
		  FROM audit_events
		 WHERE workspace_id = $1::uuid AND action = $2 AND details_redacted->>'userId' = $3`,
		ws.ID, AuditMemberRolesChange, u.ID).Scan(&n, &actor, &via, &after); err != nil {
		t.Fatal(err)
	}
	if n != 1 || actor != "" || via != MemberViaSystem || after != `["viewer"]` {
		t.Fatalf("rows=%d actor=%q via=%q after=%s", n, actor, via, after)
	}
}
