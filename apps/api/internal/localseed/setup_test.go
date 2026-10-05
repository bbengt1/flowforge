package localseed

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func TestPrepareAdminPasswordUsesEnvironmentTokenWithoutPrinting(t *testing.T) {
	store := identity.NewMemory()
	boot := bootstrap.NewMemory()
	if err := EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	const token = "setup-token-value1"
	if err := PrepareAdminPassword(t.Context(), store, boot, log, token); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), token) {
		t.Fatalf("environment token leaked: %s", buf.String())
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash != bootstrap.HashSetupToken(token) {
		t.Fatal("digest must match the environment token")
	}
}

func TestPrepareAdminPasswordLeavesRealResetAlone(t *testing.T) {
	store := identity.NewMemory()
	boot := bootstrap.NewMemory()
	if err := EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	hash, err := localauth.HashPassword("correct-horse")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(t.Context(), cred.User.ID, cred.Identifier, hash); err != nil {
		t.Fatal(err)
	}
	if err := store.RequireLocalPasswordChange(t.Context(), cred.User.ID); err != nil {
		t.Fatal(err)
	}
	if err := boot.SetSetupTokenHash(t.Context(), bootstrap.HashSetupToken("setup-token-value1")); err != nil {
		t.Fatal(err)
	}
	if err := PrepareAdminPassword(t.Context(), store, boot, nil, "setup-token-value1"); err != nil {
		t.Fatal(err)
	}
	got, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !got.MustChangePassword || !localauth.Verify("correct-horse", got.PasswordHash) {
		t.Fatalf("admin-initiated reset must stay: %+v", got)
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash != "" {
		t.Fatal("a usable password must not keep a setup token")
	}
}

func TestPrepareAdminPasswordClearsRetiredDefault(t *testing.T) {
	store := identity.NewMemory()
	boot := bootstrap.NewMemory()
	if err := EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := localauth.HashOneTimePassword()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(t.Context(), cred.User.ID, cred.Identifier, legacy); err != nil {
		t.Fatal(err)
	}
	if err := store.RequireLocalPasswordChange(t.Context(), cred.User.ID); err != nil {
		t.Fatal(err)
	}
	if err := PrepareAdminPassword(t.Context(), store, boot, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), ""); err != nil {
		t.Fatal(err)
	}
	got, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if got.PasswordHash != localauth.UnusablePasswordHash || got.MustChangePassword {
		t.Fatalf("retired hash must be cleared: %+v", got)
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !bootstrap.ValidSetupTokenHash(st.SetupTokenHash) {
		t.Fatal("cleared password must issue a setup token")
	}
}
