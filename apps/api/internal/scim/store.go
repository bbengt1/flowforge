package scim

import "context"

// Store persists SCIM user directory rows. Groups are workspaces and
// are not stored here. Identity tables stay unscoped (no workspace RLS);
// callers must not query workspace-owned rows from this store.
type Store interface {
	Save(ctx context.Context, rec Record) error
	Get(ctx context.Context, userID string) (Record, error)
	// FindByUserName returns the active row, or a deprovisioned row when
	// that is all that remains. Missing is ErrNotFound.
	FindByUserName(ctx context.Context, userName string) (Record, error)
	FindByExternalID(ctx context.Context, externalID string) (Record, error)
	// List returns active rows only. startIndex is 1-based. count 0
	// returns a nil page and the total. attr empty lists everyone.
	List(ctx context.Context, attr, value string, startIndex, count int) ([]Record, int, error)
}
