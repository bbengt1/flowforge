package authz

import "testing"

func TestValidateClaimRequiresTenantAndWorkbench(t *testing.T) {
	err := ValidateClaim(WorkspaceClaim{TenantSlug: "acme"})
	if err != ErrIncompleteWorkspaceClaim {
		t.Fatalf("got %v", err)
	}
	err = ValidateClaim(WorkspaceClaim{WorkbenchKey: "ops"})
	if err != ErrIncompleteWorkspaceClaim {
		t.Fatalf("got %v", err)
	}
	err = ValidateClaim(WorkspaceClaim{})
	if err != ErrIncompleteWorkspaceClaim {
		t.Fatalf("got %v", err)
	}
}

func TestValidateClaimRejectsHostSuppliedWorkspaceIDAlone(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	err := ValidateClaim(WorkspaceClaim{HostWorkspaceID: id})
	if err != ErrHostSuppliedWorkspaceID {
		t.Fatalf("got %v, want host-supplied rejection", err)
	}
	err = ValidateClaim(WorkspaceClaim{
		HostWorkspaceID: id,
		TenantSlug:      "acme",
	})
	if err != ErrHostSuppliedWorkspaceID {
		t.Fatalf("workspace id + tenant without workbench: %v", err)
	}
}

func TestValidateClaimAcceptsTenantWorkbenchPair(t *testing.T) {
	if err := ValidateClaim(WorkspaceClaim{
		TenantSlug:   "acme",
		WorkbenchKey: "ops",
	}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateClaim(WorkspaceClaim{
		TenantID:     "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		WorkbenchKey: "ops",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateClaimRejectsMalformedTenantOrWorkbench(t *testing.T) {
	if err := ValidateClaim(WorkspaceClaim{
		TenantID:     "not-a-uuid",
		WorkbenchKey: "ops",
	}); err != ErrAmbiguousWorkspaceIdentity {
		t.Fatalf("got %v", err)
	}
	if err := ValidateClaim(WorkspaceClaim{
		TenantSlug:   "ACME",
		WorkbenchKey: "ops",
	}); err != ErrAmbiguousWorkspaceIdentity {
		t.Fatalf("got %v", err)
	}
	if err := ValidateClaim(WorkspaceClaim{
		TenantSlug:   "acme",
		WorkbenchKey: "Ops",
	}); err != ErrAmbiguousWorkspaceIdentity {
		t.Fatalf("got %v", err)
	}
}

func TestConfirmResolvedID(t *testing.T) {
	resolved := "11111111-1111-1111-1111-111111111111"
	other := "22222222-2222-2222-2222-222222222222"
	if err := ConfirmResolvedID(resolved, ""); err != nil {
		t.Fatal(err)
	}
	if err := ConfirmResolvedID(resolved, resolved); err != nil {
		t.Fatal(err)
	}
	if err := ConfirmResolvedID(resolved, other); err != ErrWorkspaceIdentityMismatch {
		t.Fatalf("got %v", err)
	}
	if err := ConfirmResolvedID(resolved, "not-a-uuid"); err != ErrHostSuppliedWorkspaceID {
		t.Fatalf("got %v", err)
	}
}

func TestValidateClaimAllowsMatchingHostIDWhenPairPresent(t *testing.T) {
	// Presence of a host workspace ID is allowed only as a confirmation
	// value after (tenant, workbench) resolution — not as the lookup key.
	err := ValidateClaim(WorkspaceClaim{
		TenantSlug:      "acme",
		WorkbenchKey:    "ops",
		HostWorkspaceID: "11111111-1111-1111-1111-111111111111",
	})
	if err != nil {
		t.Fatal(err)
	}
}
