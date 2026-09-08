package isolation

import (
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestAuthorizeRejectsClientWorkspaceGuess(t *testing.T) {
	if _, err := Authorize("", "11111111-1111-1111-1111-111111111111"); err != ErrNoScope {
		t.Fatalf("empty workspace: %v", err)
	}
	if _, err := Authorize("not-a-uuid", "11111111-1111-1111-1111-111111111111"); err != ErrNoScope {
		t.Fatalf("malformed workspace: %v", err)
	}
	scope, err := Authorize("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	if scope.WorkspaceID() != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("workspace = %s", scope.WorkspaceID())
	}
}

func TestPermissionForIsDenyByDefault(t *testing.T) {
	if PermissionFor("unknown", "read") != "" {
		t.Fatal("unknown kind must not grant a permission")
	}
	if PermissionFor(KindCredential, "use") != authz.PermCredentialUse {
		t.Fatal("credential use")
	}
	if PermissionFor(KindArtifact, "read") != authz.PermExecutionView {
		t.Fatal("artifact read")
	}
	if PermissionFor(KindAudit, "read") != authz.PermWorkspaceAdminister {
		t.Fatal("audit read")
	}
}
