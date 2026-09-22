package machine

import "errors"

// Persistence and auth errors. Messages must not include secrets,
// hashes, or assertion plaintext.
var (
	ErrNotFound      = errors.New("machine principal not found")
	ErrConflict      = errors.New("machine principal conflict")
	ErrInvalid       = errors.New("invalid machine principal")
	ErrRevoked       = errors.New("machine principal revoked")
	ErrWorkspace     = errors.New("machine principal workspace mismatch")
	ErrBinding       = errors.New("machine principal workspace binding required")
	ErrCredential    = errors.New("invalid machine credentials")
	ErrReplay        = errors.New("machine assertion replay")
	ErrMisconfigured = errors.New("machine principal misconfigured")
)
