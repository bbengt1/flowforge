package identity

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
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

// auditRowsFor reads the workspace_member audit rows for a workspace as
// the app role under the workspace's scope.
func auditRowsFor(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string) []map[string]any {
	t.Helper()
	tx, err := postgres.BeginScoped(ctx, pool, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT COALESCE(actor_id::text, ''), action, resource_type, COALESCE(resource_id::text, ''), outcome, details_redacted
		  FROM audit_events
		 WHERE workspace_id = $1::uuid AND resource_type = $2`, workspaceID, AuditMemberResource)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var actor, action, rtype, rid, outcome string
		var details map[string]any
		if err := rows.Scan(&actor, &action, &rtype, &rid, &outcome, &details); err != nil {
			t.Fatal(err)
		}
		out = append(out, map[string]any{"actor": actor, "action": action, "resourceId": rid, "outcome": outcome, "details": details})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func rolesOf(v any) []string {
	var out []string
	if list, ok := v.([]any); ok {
		for _, item := range list {
			out = append(out, item.(string))
		}
	}
	return out
}

// #627: the creator's admin grant writes exactly one roles_change row,
// creator as actor and target, before [] and after [admin], with the
// display name and UUID only.
func TestPostgresCreateWorkspaceAuditsCreatorGrant(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := NewPostgres(pool)
	suffix := newID()[:8]
	tenant, err := store.CreateTenant(ctx, "cg-"+suffix, "Tenant "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	creator, err := store.UpsertUser(ctx, "https://idp.example", "creator-"+suffix, "Casey Creator")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(ctx, tenant.ID, "cg-"+suffix, "Creator Grant", creator.ID)
	if err != nil {
		t.Fatal(err)
	}
	rows := auditRowsFor(t, ctx, pool, ws.ID)
	if len(rows) != 1 {
		t.Fatalf("rows = %d: %v", len(rows), rows)
	}
	row := rows[0]
	details := row["details"].(map[string]any)
	if row["action"] != AuditMemberRolesChange || row["actor"] != creator.ID || row["resourceId"] != creator.ID || row["outcome"] != "updated" {
		t.Fatalf("row = %v", row)
	}
	if got := rolesOf(details["rolesBefore"]); len(got) != 0 || details["rolesBefore"] == nil {
		t.Fatalf("rolesBefore = %v", details["rolesBefore"])
	}
	if got := rolesOf(details["rolesAfter"]); len(got) != 1 || got[0] != "admin" {
		t.Fatalf("rolesAfter = %v", details["rolesAfter"])
	}
	if details["userId"] != creator.ID || details["displayName"] != "Casey Creator" || details["actorDisplayName"] != "Casey Creator" {
		t.Fatalf("details = %v", details)
	}
	for key := range details {
		switch key {
		case "userId", "rolesBefore", "rolesAfter", "displayName", "actorDisplayName":
		default:
			t.Fatalf("unexpected detail %q in %v", key, details)
		}
	}
}

// A create that fails after the grant leaves no workspace, no grant and no
// audit row: the row shares the create transaction.
func TestPostgresCreateWorkspaceAuditFailureRollsBackGrant(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)
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
	store := NewPostgres(pool)
	suffix := newID()[:8]
	tenant, err := store.CreateTenant(ctx, "cr-"+suffix, "Tenant "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	creator, err := store.UpsertUser(ctx, "https://idp.example", "rollback-"+suffix, "Rhea Rollback")
	if err != nil {
		t.Fatal(err)
	}
	// Make the audit insert for this creator fail, after the workspace
	// and the binding were written in the same transaction.
	fn, trg := "f627_fail_"+suffix, "t627_fail_"+suffix
	if _, err := admin.Exec(ctx, `CREATE FUNCTION public.`+fn+`() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
		  IF NEW.details_redacted->>'userId' = '`+creator.ID+`' THEN RAISE EXCEPTION 'forced audit failure'; END IF;
		  RETURN NEW;
		END $$`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DROP TRIGGER IF EXISTS `+trg+` ON audit_events`)
		_, _ = admin.Exec(context.Background(), `DROP FUNCTION IF EXISTS public.`+fn+`()`)
	})
	if _, err := admin.Exec(ctx, `CREATE TRIGGER `+trg+` BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.`+fn+`()`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(ctx, tenant.ID, "cr-"+suffix, "Rollback", creator.ID); err == nil {
		t.Fatal("create succeeded with a failing audit insert")
	}
	var workspaces, bindings, audits int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&workspaces); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM workspace_role_bindings WHERE user_id = $1::uuid`, creator.ID).Scan(&bindings); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE details_redacted->>'userId' = $1`, creator.ID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if workspaces != 0 || bindings != 0 || audits != 0 {
		t.Fatalf("after failed create: workspaces=%d bindings=%d audits=%d", workspaces, bindings, audits)
	}
}
