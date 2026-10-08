package localseed

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

var testWorker = authz.PrincipalRef{Issuer: localworker.DefaultIssuer, Subject: localworker.DefaultSubject}

func seedLocalWorkbench(t *testing.T, ctx context.Context, store identity.Store) identity.Workspace {
	t.Helper()
	if _, err := ProvisionAdmin(ctx, store, BootstrapIssuer, BootstrapSubject, BootstrapDisplay); err != nil {
		t.Fatal(err)
	}
	tenant, err := store.GetTenantBySlug(ctx, TenantSlug)
	if err != nil {
		t.Fatal(err)
	}
	ws, _, err := store.ResolveWorkspace(ctx, tenant.ID, tenant.Slug, WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

func assertWorkerOperator(t *testing.T, ctx context.Context, store identity.Store, workspaceID, userID string) {
	t.Helper()
	roles, perms, err := store.EffectiveAccess(ctx, workspaceID, userID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(roles, []string{authz.RoleOperator}) {
		t.Fatalf("worker roles = %v", roles)
	}
	if !authz.Allows(perms, authz.PermWorkflowExecute) || authz.Allows(perms, authz.PermApprovalDecide) || authz.Allows(perms, authz.PermWorkspaceAdminister) {
		t.Fatalf("worker perms = %v", perms)
	}
}

func TestEnsureWorkerBindsOperatorIdempotently(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	ws := seedLocalWorkbench(t, ctx, store)

	first, err := EnsureWorker(ctx, WorkerInput{Store: store, Worker: testWorker})
	if err != nil || first.Skipped != "" || !first.Changed {
		t.Fatalf("first = %+v %v", first, err)
	}
	assertWorkerOperator(t, ctx, store, ws.ID, first.UserID)
	second, err := EnsureWorker(ctx, WorkerInput{Store: store, Worker: testWorker})
	if err != nil || second.Changed || second.UserID != first.UserID {
		t.Fatalf("second = %+v %v", second, err)
	}

	// Someone made the worker admin by hand: the next boot puts it back.
	if err := store.SetMemberRoles(ctx, ws.ID, first.UserID, []string{authz.RoleAdmin, authz.RoleApprover}, identity.MemberActor{Via: identity.MemberViaSystem}); err != nil {
		t.Fatal(err)
	}
	third, err := EnsureWorker(ctx, WorkerInput{Store: store, Worker: testWorker})
	if err != nil || !third.Changed {
		t.Fatalf("third = %+v %v", third, err)
	}
	assertWorkerOperator(t, ctx, store, ws.ID, first.UserID)
}

func TestEnsureWorkerSkipsHumansAndMissingWorkbench(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()

	res, err := EnsureWorker(ctx, WorkerInput{Store: store, Worker: testWorker})
	if err != nil || res.Skipped == "" {
		t.Fatalf("missing local = %+v %v", res, err)
	}
	if _, err := store.GetTenantBySlug(ctx, TenantSlug); err == nil {
		t.Fatal("worker binding must not create the local tenant")
	}

	ws := seedLocalWorkbench(t, ctx, store)
	admin1 := authz.PrincipalRef{Issuer: "https://idp.example", Subject: "admin-1"}
	adminUser, err := ProvisionAdmin(ctx, store, admin1.Issuer, admin1.Subject, AdminDisplay)
	if err != nil {
		t.Fatal(err)
	}
	for _, human := range []authz.PrincipalRef{admin1, {Issuer: BootstrapIssuer, Subject: BootstrapSubject}} {
		res, err := EnsureWorker(ctx, WorkerInput{Store: store, Worker: human, Humans: []authz.PrincipalRef{admin1}})
		if err != nil || res.Skipped == "" || res.Changed {
			t.Fatalf("human %+v = %+v %v", human, res, err)
		}
	}
	_, perms, err := store.EffectiveAccess(ctx, ws.ID, adminUser.ID)
	if err != nil || !authz.Allows(perms, authz.PermWorkspaceAdminister) {
		t.Fatalf("human admin was rebound: %v %v", perms, err)
	}
}

// TestEnsureWorkerPostgres runs the boot binding against an existing local
// workbench twice, then repairs a worker that was widened by hand.
func TestEnsureWorkerPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	app, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	store := identity.NewPostgres(app)
	ws := seedLocalWorkbench(t, ctx, store)
	worker := authz.PrincipalRef{Issuer: localworker.DefaultIssuer, Subject: fmt.Sprintf("%s-%d", localworker.DefaultSubject, time.Now().UnixNano())}
	in := WorkerInput{Store: store, Worker: worker}

	first, err := EnsureWorker(ctx, in)
	if err != nil || first.Skipped != "" || !first.Changed {
		t.Fatalf("first = %+v %v", first, err)
	}
	assertWorkerOperator(t, ctx, store, ws.ID, first.UserID)
	second, err := EnsureWorker(ctx, in)
	if err != nil || second.Changed || second.UserID != first.UserID {
		t.Fatalf("second = %+v %v", second, err)
	}
	if err := store.SetMemberRoles(ctx, ws.ID, first.UserID, []string{authz.RoleAdmin, authz.RoleApprover}, identity.MemberActor{Via: identity.MemberViaSystem}); err != nil {
		t.Fatal(err)
	}
	third, err := EnsureWorker(ctx, in)
	if err != nil || !third.Changed {
		t.Fatalf("third = %+v %v", third, err)
	}
	assertWorkerOperator(t, ctx, store, ws.ID, first.UserID)
}
