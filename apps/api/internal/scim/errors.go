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
)
