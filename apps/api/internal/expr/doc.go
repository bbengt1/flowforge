// Package expr is FFX, Flowforge's typed expression language (#650 §4),
// built on cel-go.
//
// Check (E3.2) is the publish-time half: parse, static reference
// extraction, type check against port kinds, size and nesting limits and a
// static cost estimate. Eval (E3.3) is the runtime half: it re-checks the
// same source, builds the program only through newProgram with
// ProgramOptions (cel.CostLimit together with cel.InterruptCheckFrequency),
// adds the 10 ms evaluation deadline and type-checks dyn results against
// the field kind, failing closed.
//
// The environment starts on purpose from cel.NewEnv's standard library. No
// cel-go ext package is enabled (in particular never ext.Encoders, which
// would let base64 carry values past redaction). Macros are cut down to the
// bounded all/exists/map/filter set. Presence tests (has) are not enabled;
// use the in operator instead (for example 'k' in m). A nested ternary
// without brackets, like true ? true ? 1 : 0 : 0, gives expression-parse,
// so bracket nested ternaries: true ? (true ? 1 : 0) : 0. There are no
// user-defined functions and no wall-clock function: CEL's standard library
// has no now(), and run.clock is an injected per-attempt value.
package expr
