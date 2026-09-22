package oidc

import (
	"context"
	"crypto/sha256"
	"time"
)

// Tx is one in-flight Authorization Code transaction. The verifier
// ciphertext is unusable without StateKey. Nonce is the authorize-request
// value checked against the ID token; it is not a credential.
type Tx struct {
	ID           string
	StateHash    []byte
	VerifierBlob []byte
	Nonce        string
	ExpiresAt    time.Time
}

// Store persists PKCE transactions. Implementations must consume each
// state at most once.
type Store interface {
	Put(ctx context.Context, tx Tx) error
	// Consume returns the transaction and marks it used. A missing,
	// expired, or already-used state is ErrRejected.
	Consume(ctx context.Context, stateHash []byte, now time.Time) (Tx, error)
}

func hashState(state string) []byte {
	sum := sha256.Sum256([]byte(state))
	return sum[:]
}
