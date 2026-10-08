package scim

import "errors"

// Persistence and request errors. Details returned to clients stay static
// and never include the bearer token, passwords, or other secrets.
var (
	ErrNotFound    = errors.New("scim resource not found")
	ErrConflict    = errors.New("scim conflict")
	ErrInvalid     = errors.New("invalid scim resource")
	ErrSecret      = errors.New("scim secret field")
	ErrUnavailable = errors.New("scim store unavailable")
	// ErrUnauthorized is a workspace token that is malformed, unknown, or
	// revoked, or whose workspace or tenant is not active.
	ErrUnauthorized = errors.New("scim token not accepted")
	// ErrTokenLimit refuses a third active workspace token.
	ErrTokenLimit = errors.New("scim token limit reached")
	// ErrLastAdmin refuses a removal that would leave the workspace with
	// no administrator. Nothing changes.
	ErrLastAdmin = errors.New("scim removal would remove the last admin")
)
