package scripts

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestRevokeBlocksDispatchAndIsSecretFree(t *testing.T) {
	ctx := context.Background()
	scope := testScope(t)
	key := NewSigningKey()
	p := &Pipeline{Store: NewMemory(), Key: key}
	art, err := p.Publish(ctx, scope, validPythonInput())
	if err != nil {
		t.Fatal(err)
	}
	if err := AuthorizeRevoke(nil); err == nil {
		t.Fatal("empty perms must deny revoke")
	}
	if err := AuthorizeRevoke([]string{authz.PermScriptRevoke}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateRevokeReason("token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\""); err == nil {
		t.Fatal("secret reason must fail closed")
	}

	revoked, err := p.Revoke(ctx, scope, RevokeInput{ArtifactID: art.ID, Reason: "incident-42", Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if revoked.RevokedAt == nil || revoked.RevokedAt.IsZero() {
		t.Fatalf("revokedAt = %+v", revoked)
	}
	again, err := p.Revoke(ctx, scope, RevokeInput{ArtifactID: art.ID, Reason: "incident-42", Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if !again.RevokedAt.Equal(*revoked.RevokedAt) {
		t.Fatal("revoke must be idempotent")
	}
	if err := VerifyForDispatch(again, key); err != ErrRevoked {
		t.Fatalf("verify revoked = %v", err)
	}
	out := Execute(ctx, Request{
		Artifact: again, Source: validPythonInput().Source, Language: LanguagePython,
		Entrypoint: "main.py", SigningKey: key, RuntimeProfile: approvedPythonProfile(),
		Permissions: operatorPerms(),
	})
	if out.OK || out.Error == nil || out.Error.Code != CodeArtifactRevoked {
		t.Fatalf("execute revoked = %+v", out)
	}
	audit := RevokeAudit(again, scope.ActorID(), "incident-42")
	raw := strings.ToLower(strings.Join(mapKeys(audit), " "))
	for _, needle := range []string{"package", "storageref", "signature", "token", "password"} {
		if strings.Contains(raw, needle) {
			t.Fatalf("audit key leaked %s: %+v", needle, audit)
		}
	}
	if _, ok := audit["artifactDigest"]; !ok {
		t.Fatalf("audit = %+v", audit)
	}
}

func mapKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
