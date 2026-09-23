package machine

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/page"
)

// Input is a create request after the caller has hashed the secret
// and resolved the workspace. SecretHash is never copied onto View.
type Input struct {
	UserID       string
	ClientID     string
	DisplayName  string
	SecretHash   string
	PublicKey    []byte
	Grants       []string
	TenantID     string
	WorkspaceID  string
	WorkbenchKey string
	Now          time.Time
}

// Rotation replaces a factor. Empty SecretHash leaves the hash.
// Nil PublicKey leaves the key. At least one factor must remain.
type Rotation struct {
	SecretHash string
	PublicKey  []byte
	Now        time.Time
}

// Store persists machine principals and assertion replay ids.
// Identity substrate: no workspace RLS. Callers still authorize in
// the API before use.
type Store interface {
	Create(ctx context.Context, in Input) (Principal, error)
	Get(ctx context.Context, id string) (Principal, error)
	GetByClientID(ctx context.Context, clientID string) (Principal, error)
	GetByUserID(ctx context.Context, userID string) (Principal, error)
	List(ctx context.Context) ([]Principal, error)
	// ListPage is the HTTP keyset page. Search matches display name and client id — never secrets or keys.
	ListPage(ctx context.Context, q page.Query) ([]Principal, string, error)
	Rotate(ctx context.Context, id string, rot Rotation) (Principal, error)
	Revoke(ctx context.Context, id string, now time.Time) (Principal, error)
	// ConsumeJTI records jti until retainUntil. now is the same clock
	// that verified the assertion. A repeated jti is ErrReplay.
	ConsumeJTI(ctx context.Context, jti, clientID string, retainUntil, now time.Time) error
}
