package vault

import (
	"context"
	"fmt"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/kms"
)

const resolveTimeout = 15 * time.Second

// ResolveKeys loads the active data-encryption KEK for the existing vault.
//
// Production is KMS-wrapped only. If the KMS cannot unwrap the blob,
// this returns an error and does not fall back to CREDENTIAL_KEK.
// Local and dev may use that documented envelope stub only when
// KMS_PROVIDER is unset. Partial KMS configuration fails closed in
// every environment. The returned bytes must not be logged.
func ResolveKeys(ctx context.Context, productionLocked bool) (Keys, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()

	provider, err := kms.Open(productionLocked)
	if err != nil {
		return Keys{}, err
	}
	if provider == nil {
		keys, err := LoadKeys()
		if err != nil {
			return Keys{}, err
		}
		if productionLocked && keys.Ready() {
			return Keys{}, fmt.Errorf("production-locked process requires %s; plaintext %s is refused", kms.EnvProvider, EnvKEK)
		}
		return keys, nil
	}
	material, err := kms.Resolve(ctx, provider)
	if err != nil {
		return Keys{}, err
	}
	keys := Keys{
		KEK:        material.KEK,
		ID:         material.ID,
		Previous:   material.Previous,
		PreviousID: material.PreviousID,
	}
	if !keys.Ready() || (len(keys.Previous) > 0 && !keys.previousReady()) {
		wipe(keys.KEK)
		wipe(keys.Previous)
		return Keys{}, fmt.Errorf("unwrapped KEK must be 32 bytes")
	}
	return keys, nil
}
