package wfstore

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// oldDraftYAML is a draft saved before #649 S2 tightened the validator:
// onError: continue on a branching node and an error edge on a node
// without errorOutput. Both are refused at save/validate now, but a draft
// already stored this way must still load (and list) unchanged.
const oldDraftYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: old-draft-649
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.condition
      name: Gate
      onError: continue
      with:
        op: eq
        path: status
        compare: ready
    - id: boom
      type: flow.fail
      name: Boom
      with:
        code: team.boom
    - id: handled
      type: flow.stop
      name: Handled
      with:
        status: success
  edges:
    - from: gate.true
      to: boom.input
    - from: boom.error
      to: handled.input
`

const oldDraftSeedYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: old-draft-649
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: boom
      type: flow.fail
      name: Boom
      with:
        code: team.boom
`

func checkOldDraftLoads(t *testing.T, ctx context.Context, store Store, scope isolation.Scope, wfID string) {
	t.Helper()
	d, err := store.GetDraft(ctx, scope, wfID)
	if err != nil {
		t.Fatalf("old draft GetDraft: %v", err)
	}
	if !strings.Contains(d.DefinitionYAML, "onError: continue") || !strings.Contains(d.DefinitionYAML, "boom.error") {
		t.Fatalf("old draft changed on load:\n%s", d.DefinitionYAML)
	}
	if _, err := store.Get(ctx, scope, wfID); err != nil {
		t.Fatalf("old draft workflow Get: %v", err)
	}
}

func TestMemoryOldDraftStillLoads649(t *testing.T) {
	ctx := context.Background()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	m := NewMemory()
	n := mustNormalize(t, oldDraftSeedYAML)
	wf, _, err := m.Create(ctx, scope, CreateInput{NormalizedYAML: n.NormalizedYAML, Digest: n.Digest, Summary: n.Summary})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	row := m.workflows[wf.ID]
	row.draft.DefinitionYAML = oldDraftYAML
	m.workflows[wf.ID] = row
	m.mu.Unlock()
	checkOldDraftLoads(t, ctx, m, scope, wf.ID)
}

func TestPostgresOldDraftStillLoads649(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
	ws, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(ws, userID)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPostgres(app)
	n := mustNormalize(t, strings.Replace(oldDraftSeedYAML, "old-draft-649", "old-draft-649-"+strings.ToLower(time.Now().Format("150405999")), 1))
	wf, _, err := store.Create(ctx, scope, CreateInput{NormalizedYAML: n.NormalizedYAML, Digest: n.Digest, Summary: n.Summary})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `UPDATE workflow_drafts SET normalized_yaml = $2 WHERE workflow_id = $1::uuid`, wf.ID, oldDraftYAML); err != nil {
		t.Fatal(err)
	}
	checkOldDraftLoads(t, ctx, store, scope, wf.ID)
}
