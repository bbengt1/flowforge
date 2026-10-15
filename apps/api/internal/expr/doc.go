// Package expr is FFX, Flowforge's typed expression language (#650 §4),
// built on cel-go.
//
// E3.2 provides the publish-time half only: parse, static reference
// extraction, type check against port kinds, size and nesting limits and a
// static cost estimate. Nothing in the engine evaluates an expression yet
// (E3.3 does). Program options for runtime (cel.CostLimit together with
// cel.InterruptCheckFrequency) are fixed here from the first commit so the
// runtime slice cannot forget them.
//
// The environment starts on purpose from cel.NewEnv's standard library. No
// cel-go ext package is enabled (in particular never ext.Encoders, which
// would let base64 carry values past redaction). Macros are cut down to the
// bounded all/exists/map/filter set. There are no user-defined functions
// and no wall-clock function: CEL's standard library has no now(), and
// run.clock is an injected per-attempt value.
package expr
