// Package kekrotate is the operator path for wrapping a data-encryption
// KEK and rewrapping stored DEKs. Output is wrapped material and counts
// only. Plaintext KEK bytes are never written.
package kekrotate

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/config"
	"github.com/bbengt1/flowforge/apps/api/internal/kms"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

// ErrUsage is returned for an unknown command. The text names commands,
// not key material.
var ErrUsage = fmt.Errorf("usage: kek-rotate wrap [--generate] | rotate | rewrap | reencrypt")

// Run executes one operator command. stdout receives wrapped blobs or
// reencrypt counts. It must not receive plaintext KEK or DEK bytes.
func Run(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return ErrUsage
	}
	switch args[0] {
	case "wrap":
		return cmdWrap(ctx, args[1:], stdout)
	case "rotate":
		if len(args) != 1 {
			return ErrUsage
		}
		return cmdRotate(ctx, stdout)
	case "rewrap":
		if len(args) != 1 {
			return ErrUsage
		}
		return cmdRewrap(ctx, stdout)
	case "reencrypt":
		if len(args) != 1 {
			return ErrUsage
		}
		return cmdReencrypt(ctx, stdout)
	default:
		return ErrUsage
	}
}

func cmdWrap(ctx context.Context, args []string, stdout io.Writer) error {
	generate := false
	for _, arg := range args {
		if arg == "--generate" {
			generate = true
			continue
		}
		return ErrUsage
	}
	p, err := kms.Open(authz.ProductionLockedFromEnv())
	if err != nil {
		return err
	}
	if p == nil {
		return fmt.Errorf("%s is required", kms.EnvProvider)
	}
	kek, id, err := kekForWrap(p, generate)
	if err != nil {
		return err
	}
	defer kms.Wipe(kek)
	blob, err := kms.WrapBlob(ctx, p, kek)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "CREDENTIAL_KEK_WRAPPED=%s\nCREDENTIAL_KEK_ID=%s\n", blob, id)
	return err
}

func kekForWrap(p kms.Provider, generate bool) ([]byte, string, error) {
	plainSet := strings.TrimSpace(os.Getenv(vault.EnvKEK)) != "" || strings.TrimSpace(os.Getenv(vault.EnvKEKFile)) != ""
	if generate {
		if plainSet {
			return nil, "", fmt.Errorf("%s must be unset with --generate", vault.EnvKEK)
		}
		kek := make([]byte, 32)
		if _, err := rand.Read(kek); err != nil {
			return nil, "", fmt.Errorf("generate KEK: %w", err)
		}
		id, err := kms.NewKeyReference(p.Name())
		if err != nil {
			kms.Wipe(kek)
			return nil, "", err
		}
		return kek, id, nil
	}
	keys, err := vault.LoadKeys()
	if err != nil {
		return nil, "", err
	}
	if !keys.Ready() {
		return nil, "", fmt.Errorf("%s is required", vault.EnvKEK)
	}
	return append([]byte(nil), keys.KEK...), keys.ID, nil
}

func cmdRotate(ctx context.Context, stdout io.Writer) error {
	p, material, err := openMaterial(ctx)
	if err != nil {
		return err
	}
	defer kms.Wipe(material.KEK)
	defer kms.Wipe(material.Previous)
	prevBlob, err := kms.CurrentWrapped()
	if err != nil {
		return err
	}
	next := make([]byte, 32)
	if _, err := rand.Read(next); err != nil {
		return fmt.Errorf("generate KEK: %w", err)
	}
	defer kms.Wipe(next)
	blob, err := kms.WrapBlob(ctx, p, next)
	if err != nil {
		return err
	}
	id, err := kms.NewKeyReference(p.Name())
	if err != nil {
		return err
	}
	if id == material.ID {
		return fmt.Errorf("%s collides with the active key reference", kms.EnvKEKID)
	}
	_, err = fmt.Fprintf(stdout, "CREDENTIAL_KEK_PREVIOUS_WRAPPED=%s\nCREDENTIAL_KEK_PREVIOUS_ID=%s\nCREDENTIAL_KEK_WRAPPED=%s\nCREDENTIAL_KEK_ID=%s\n", prevBlob, material.ID, blob, id)
	return err
}

func cmdRewrap(ctx context.Context, stdout io.Writer) error {
	p, material, err := openMaterial(ctx)
	if err != nil {
		return err
	}
	defer kms.Wipe(material.KEK)
	defer kms.Wipe(material.Previous)
	blob, err := kms.WrapBlob(ctx, p, material.KEK)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "CREDENTIAL_KEK_WRAPPED=%s\nCREDENTIAL_KEK_ID=%s\n", blob, material.ID)
	return err
}

func cmdReencrypt(ctx context.Context, stdout io.Writer) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if !cfg.VaultKeys.Ready() {
		return vault.ErrKeyUnavailable
	}
	if cfg.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	pool, err := postgres.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	stats, err := vault.ReencryptAll(ctx, pool, cfg.VaultKeys)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "workspaces=%d\ncredentials=%d\nartifacts=%d\n", stats.Workspaces, stats.Credentials, stats.Artifacts)
	return err
}

func openMaterial(ctx context.Context) (kms.Provider, kms.Material, error) {
	p, err := kms.Open(authz.ProductionLockedFromEnv())
	if err != nil {
		return nil, kms.Material{}, err
	}
	if p == nil {
		return nil, kms.Material{}, fmt.Errorf("%s is required", kms.EnvProvider)
	}
	material, err := kms.Resolve(ctx, p)
	if err != nil {
		return nil, kms.Material{}, err
	}
	return p, material, nil
}
