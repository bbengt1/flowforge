package portal

import "errors"

// Adapter errors. Callers must fail closed.
var (
	ErrRoleRequired      = errors.New("portal roles or capabilities are required")
	ErrUnknownRole       = errors.New("portal role is not in the capability map")
	ErrUnknownCapability = errors.New("portal capability is not a FlowForge permission")
	ErrIssuer            = errors.New("portal issuer is not on the Portal allowlist")
	ErrHostileHost       = errors.New("portal host context is not trusted")
	ErrSharesBoundary    = errors.New("portal adapter does not share FlowForge database or executor")
)
