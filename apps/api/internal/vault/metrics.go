package vault

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

// noteVault records a vault operation without secret material, credential
// ids, or error text. Unknown op/result pairs are dropped by observability.
func noteVault(ctx context.Context, op string, err error) {
	result := "ok"
	if err != nil {
		result = "error"
	}
	observability.NoteVault(ctx, op, result)
}
