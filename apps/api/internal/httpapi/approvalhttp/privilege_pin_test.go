package approvalhttp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestPolicyVersionPrivilegeDeniedStaysPending(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
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
	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, fmt.Sprintf("pv-%d", suffix%100000000), "PV")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", fmt.Sprintf("pvu-%d", suffix%100000000), "Owner")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, fmt.Sprintf("pvw-%d", suffix%100000000), "Desk", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	ops := opsconfig.NewPostgres(app)
	store := wfstore.NewPostgres(app)
	approvals := approval.NewPostgres(app)
	spec := map[string]any{"kind": "approval", "policy": map[string]any{"approverRole": "approver", "expiresIn": "PT1H"}}
	resource, draft, err := ops.Create(ctx, scope, opsconfig.CreateInput{
		Kind: opsconfig.KindPolicy, Name: "Version grant", Slug: fmt.Sprintf("vg-%d", suffix%100000000), Spec: spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ops.Publish(ctx, scope, opsconfig.KindPolicy, resource.ID, opsconfig.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"}); err != nil {
		t.Fatal(err)
	}
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: version-grant-` + fmt.Sprintf("%d", suffix%100000000) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        policyId: ` + resource.ID + `
        expiresIn: PT1H
  edges: []
`
	parsed, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, wfDraft, err := store.Create(ctx, scope, wfstore.CreateInput{
		NormalizedYAML: parsed.NormalizedYAML, Digest: parsed.Digest, Summary: parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: wfDraft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	rec, err := approvals.Create(ctx, scope, approval.CreateInput{
		WorkflowID: wf.ID, WorkflowVersionID: ver.ID, WorkflowDigest: ver.Digest, RequestedBy: user.ID,
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := approval.ResolveGateRequirement(ctx, scope, store, ops, wf.ID, ver.ID, "gate", time.Now().UTC()); err != nil {
		t.Fatalf("resolve before revoke = %v", err)
	}
	if _, err := admin.Exec(ctx, `REVOKE SELECT ON ops_resource_versions FROM flowforge_app`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), `GRANT SELECT ON ops_resource_versions TO flowforge_app`)
	}()

	_, err = approval.ResolveGateRequirement(ctx, scope, store, ops, wf.ID, ver.ID, "gate", time.Now().UTC())
	if !errors.Is(err, approval.ErrBindingTransient) || errors.Is(err, approval.ErrBindingUnresolved) || errors.Is(err, opsconfig.ErrDraftNotUsable) {
		t.Fatalf("resolve = %v", err)
	}
	httpRec := httptest.NewRecorder()
	WriteApprovalError(httpRec, httptest.NewRequest(http.MethodPost, "/api/v1/approvals/"+rec.ID+"/decide", nil), err)
	if httpRec.Code != http.StatusServiceUnavailable || httpRec.Header().Get("Retry-After") != "5" || !strings.Contains(httpRec.Body.String(), "approval_requirement_unavailable") {
		t.Fatalf("decide = %d %q %s", httpRec.Code, httpRec.Header().Get("Retry-After"), httpRec.Body.String())
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != approval.StatusPending || got.CloseReason != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
	events, err := approvals.Events(ctx, scope, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.EventType == approval.EventCanceled {
			t.Fatalf("canceled = %+v", ev)
		}
	}
}
