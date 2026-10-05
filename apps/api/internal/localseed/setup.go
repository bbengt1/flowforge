package localseed

import (
	"context"
	"errors"
	"log/slog"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
)

// PrepareAdminPassword clears a retired default hash and, while the
// seeded admin still has no usable password, stores a setup-token
// digest. A generated token is printed once. An operator-supplied
// token is not printed. The plaintext is never written to the database.
func PrepareAdminPassword(ctx context.Context, store identity.Store, boot bootstrap.Store, log *slog.Logger, envToken string) error {
	if store == nil || boot == nil {
		return errors.New("admin password setup: store is required")
	}
	if err := bootstrap.ValidateSetupToken(envToken); err != nil {
		return err
	}
	if err := clearLegacyDefaultPassword(ctx, store); err != nil {
		return err
	}
	return issueSetupToken(ctx, store, boot, log, envToken)
}

func clearLegacyDefaultPassword(ctx context.Context, store identity.Store) error {
	login, err := store.LookupLocalLogin(ctx, localauth.OneTimeIdentifier)
	if errors.Is(err, identity.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !login.MustChangePassword {
		return nil
	}
	if !localauth.Verify(localauth.OneTimePassword, login.PasswordHash) {
		return nil
	}
	return store.SetLocalPassword(ctx, login.User.ID, login.Identifier, localauth.UnusablePasswordHash)
}

func issueSetupToken(ctx context.Context, store identity.Store, boot bootstrap.Store, log *slog.Logger, envToken string) error {
	login, err := store.LookupLocalLogin(ctx, localauth.OneTimeIdentifier)
	if errors.Is(err, identity.ErrNotFound) {
		return boot.ClearSetupTokenHash(ctx)
	}
	if err != nil {
		return err
	}
	if localauth.PasswordHashUsable(login.PasswordHash) {
		return boot.ClearSetupTokenHash(ctx)
	}
	token := envToken
	generated := false
	if token == "" {
		minted, err := bootstrap.GenerateSetupToken()
		if err != nil {
			return err
		}
		token = minted
		generated = true
	}
	hash := bootstrap.HashSetupToken(token)
	if err := boot.SetSetupTokenHash(ctx, hash); err != nil {
		return err
	}
	if generated {
		logger(log).Warn("first-run admin setup is waiting for a password", "setup", token)
	} else {
		logger(log).Info("first-run admin setup is waiting for a password", "source", "environment")
	}
	return nil
}
