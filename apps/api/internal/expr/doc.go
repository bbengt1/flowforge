// Package expr will hold Flowforge's typed expression language (#650 §4),
// built on cel-go. E3.0 only pins the dependency; no expression is evaluated
// yet. Later slices enable allowlisted extensions only (never ext.Encoders).
package expr

import (
	// Compile anchor so `go mod tidy` keeps the pinned cel-go module until
	// E3.2 adds real usage.
	_ "cel.dev/cel-go/cel"
)
