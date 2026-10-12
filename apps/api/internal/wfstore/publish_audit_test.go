package wfstore

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func assertPublishAudit(t *testing.T, ev AuditEvent, scope isolation.Scope, ver Version, wantName string) {
	t.Helper()
	d := ev.Details
	if ev.Action != ActionWorkflowPublish || ev.Outcome != "published" || ev.ResourceType != "workflow" || ev.ResourceID != ver.WorkflowID || ev.ActorID != scope.ActorID() {
		t.Fatalf("audit = %+v", ev)
	}
	if d["workflowId"] != ver.WorkflowID || d["versionId"] != ver.ID || d["digest"] != ver.Digest || d["note"] != ver.PublishNote || d["actorId"] != scope.ActorID() {
		t.Fatalf("details = %+v", d)
	}
	if n, ok := asIntAny(d["versionNumber"]); !ok || n != ver.VersionNumber {
		t.Fatalf("versionNumber = %v", d["versionNumber"])
	}
	if got, _ := d["actorDisplayName"].(string); got != wantName {
		t.Fatalf("actorDisplayName = %q want %q", got, wantName)
	}
	for k, v := range d {
		if s, ok := v.(string); ok && (strings.Contains(s, "apiVersion") || strings.Contains(s, "kind: Workflow")) {
			t.Fatalf("audit %s carries spec", k)
		}
	}
	for _, k := range []string{"definitionYaml", "normalizedYaml", "spec", "summary"} {
		if _, ok := d[k]; ok {
			t.Fatalf("audit carries %s", k)
		}
	}
}

func TestMemoryPublishWritesAudit(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	store.ActorDisplayName = func(string) string { return "Pat Publisher" }
	scope := deleteScope(t)
	norm := mustNormalize(t, fixtureYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "ship it"})
	if err != nil {
		t.Fatal(err)
	}
	audits, err := store.ListAuditEvents(ctx, scope, AuditListFilter{Action: ActionWorkflowPublish})
	if err != nil || len(audits) != 1 {
		t.Fatalf("audits = %+v %v", audits, err)
	}
	assertPublishAudit(t, audits[0], scope, ver, "Pat Publisher")
}

func TestPostgresPublishAuditSameTxAndFailClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
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
	wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scopeA, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}
	var displayName string
	if err := admin.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1::uuid`, userID).Scan(&displayName); err != nil {
		t.Fatal(err)
	}

	norm := mustNormalize(t, fixtureYAML)
	wf, draft, err := store.Create(ctx, scopeA, CreateInput{Slug: "publish-audit-ok", NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scopeA, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "ship it"})
	if err != nil {
		t.Fatal(err)
	}
	audits, err := store.ListAuditEvents(ctx, scopeA, AuditListFilter{Action: ActionWorkflowPublish, ResourceID: wf.ID})
	if err != nil || len(audits) != 1 {
		t.Fatalf("audits = %+v %v", audits, err)
	}
	assertPublishAudit(t, audits[0], scopeA, ver, displayName)
	// RLS: the other workspace cannot see the row.
	other, err := store.ListAuditEvents(ctx, scopeB, AuditListFilter{Action: ActionWorkflowPublish, ResourceID: wf.ID})
	if err != nil || len(other) != 0 {
		t.Fatalf("cross-workspace audits = %+v %v", other, err)
	}

	// Fail closed: an audit insert error rolls back the version insert.
	wf2, draft2, err := store.Create(ctx, scopeA, CreateInput{Slug: "publish-audit-fail", NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		DROP TRIGGER IF EXISTS ff_test_block_publish_audit ON audit_events;
		CREATE OR REPLACE FUNCTION ff_test_block_publish_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.action = 'workflow.publish' AND NEW.resource_id = '`+wf2.ID+`'::uuid THEN
				RAISE EXCEPTION 'audit blocked by test';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER ff_test_block_publish_audit BEFORE INSERT ON audit_events
			FOR EACH ROW EXECUTE FUNCTION ff_test_block_publish_audit();
	`); err != nil {
		t.Fatal(err)
	}
	// defer (not t.Cleanup): admin is closed by an earlier defer.
	defer func() {
		_, _ = admin.Exec(context.Background(), `DROP TRIGGER IF EXISTS ff_test_block_publish_audit ON audit_events; DROP FUNCTION IF EXISTS ff_test_block_publish_audit();`)
	}()
	if _, _, err := store.Publish(ctx, scopeA, wf2.ID, PublishInput{ExpectedRevision: draft2.Revision}); err == nil {
		t.Fatal("publish succeeded although its audit row failed")
	}
	vers, err := store.ListVersions(ctx, scopeA, wf2.ID)
	if err != nil || len(vers) != 0 {
		t.Fatalf("versions after failed audit = %+v %v", vers, err)
	}
	got, err := store.Get(ctx, scopeA, wf2.ID)
	if err != nil || got.Status != StatusDraft {
		t.Fatalf("workflow after failed audit = %+v %v", got, err)
	}
}
