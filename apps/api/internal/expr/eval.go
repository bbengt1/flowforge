package expr

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"cel.dev/cel-go/cel"
	"cel.dev/cel-go/common/types"
	"cel.dev/cel-go/common/types/ref"
	"cel.dev/cel-go/common/types/traits"
)

// Runtime limits (#650 §4). EvalDeadline bounds one evaluation;
// StepDeadline bounds every evaluation a step makes together.
const (
	EvalDeadline = 10 * time.Millisecond
	StepDeadline = 2 * time.Second

	// MaxResultBytes is MaxItemBytes: the JSON size of a result.
	MaxResultBytes = maxStringSize
	maxResultDepth = 32
)

// Env is the runtime binding for one evaluation. Only the names an
// expression statically references are bound. vars is never bound: a
// secret value is never readable from an expression.
type Env struct {
	Item     map[string]any
	HasItem  bool
	Items    []any
	HasItems bool
	Trigger  map[string]any
	Inputs   map[string]any
	// Run and Workflow fields; a nil Clock or zero StartedAt is unavailable.
	RunID      string
	StartedAt  time.Time
	Clock      *time.Time
	WorkflowID string
	VersionID  string
}

// Eval checks src against sc exactly as publish does, then evaluates it
// with the E3.2 ProgramOptions (CostLimit + InterruptCheckFrequency) under
// the 10 ms deadline. It returns a JSON-shaped Go value (map[string]any,
// []any, string, int64, float64, bool, nil) that has passed the runtime
// type check against sc.Want. Errors are fixed strings: they never echo the
// expression or any value.
func Eval(ctx context.Context, src string, sc Scope, env Env) (any, *Error) {
	res, celEnv, checked, cerr := compile(src, sc)
	if cerr != nil {
		return nil, cerr
	}
	if len(res.Refs.Vars) > 0 {
		// No core field resolves a credential ref in-process.
		return nil, fail(CodeSecretUse, "vars cannot be read during evaluation.")
	}
	act, aerr := activation(res.Refs, env)
	if aerr != nil {
		return nil, aerr
	}
	prg, err := newProgram(celEnv, checked)
	if err != nil {
		return nil, fail(CodeRuntime, "Expression could not be prepared.")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ectx, cancel := context.WithTimeout(ctx, EvalDeadline)
	defer cancel()
	if ectx.Err() != nil {
		return nil, classifyEvalError(ectx, ectx.Err())
	}
	out, _, err := prg.ContextEval(ectx, act)
	if err == nil && ectx.Err() != nil {
		// Finished, but past the deadline: fail closed.
		err = ectx.Err()
	}
	if err != nil {
		return nil, classifyEvalError(ectx, err)
	}
	v, verr := toNative(out, 0)
	if verr != nil {
		return nil, verr
	}
	if e := checkRuntimeWant(v, sc); e != nil {
		return nil, e
	}
	raw, err := json.Marshal(v)
	if err != nil || len(raw) > MaxResultBytes {
		return nil, fail(CodeRuntime, "Expression result is over the item size limit.")
	}
	return v, nil
}

// newProgram is the only place an FFX program is built. Every program
// carries ProgramOptions (#650 E3.3 binding rule); program_options_650_test
// fails if any other file in this package calls Program.
func newProgram(env *cel.Env, checked *cel.Ast) (cel.Program, error) {
	return env.Program(checked, ProgramOptions()...)
}

func classifyEvalError(ctx context.Context, err error) *Error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.Canceled) {
		return fail(CodeTimeout, "Expression did not finish within its time limit.")
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "actual cost limit exceeded"):
		return fail(CodeCostExceeded, "Expression exceeded its cost limit.")
	case strings.Contains(msg, "interrupted"), strings.Contains(msg, "operation cancelled"):
		return fail(CodeTimeout, "Expression did not finish within its time limit.")
	}
	return fail(CodeRuntime, "Expression failed at runtime (for example a missing field or a type mismatch).")
}

func activation(r Refs, env Env) (map[string]any, *Error) {
	act := map[string]any{}
	if r.Item {
		if !env.HasItem {
			return nil, fail(CodeRuntime, "item is not an object at runtime.")
		}
		nv, nerr := normalizeJSON(env.Item, 0)
		if nerr != nil {
			return nil, nerr
		}
		act["item"] = nv
	}
	if r.Items {
		if !env.HasItems {
			return nil, fail(CodeRuntime, "items is not available at runtime.")
		}
		nv, nerr := normalizeJSON(env.Items, 0)
		if nerr != nil {
			return nil, nerr
		}
		act["items"] = nv
	}
	if r.Trigger {
		if env.Trigger == nil {
			return nil, fail(CodeRuntime, "trigger is not available at runtime.")
		}
		nv, nerr := normalizeJSON(env.Trigger, 0)
		if nerr != nil {
			return nil, nerr
		}
		act["trigger"] = nv
	}
	for _, p := range r.Inputs {
		v, ok := env.Inputs[p]
		if !ok {
			return nil, fail(CodeRuntime, "An input port the expression reads was not delivered.")
		}
		nv, nerr := normalizeJSON(v, 0)
		if nerr != nil {
			return nil, nerr
		}
		act["input."+p] = nv
	}
	for _, f := range r.Run {
		switch f {
		case "id":
			if env.RunID == "" {
				return nil, fail(CodeRuntime, "run.id is not available at runtime.")
			}
			act["run.id"] = env.RunID
		case "startedAt":
			if env.StartedAt.IsZero() {
				return nil, fail(CodeRuntime, "run.startedAt is not available at runtime.")
			}
			act["run.startedAt"] = env.StartedAt.UTC()
		case "clock":
			if env.Clock == nil || env.Clock.IsZero() {
				return nil, fail(CodeRuntime, "run.clock is not set for this attempt.")
			}
			act["run.clock"] = env.Clock.UTC()
		}
	}
	for _, f := range r.Workflow {
		switch f {
		case "id":
			if env.WorkflowID == "" {
				return nil, fail(CodeRuntime, "workflow.id is not available at runtime.")
			}
			act["workflow.id"] = env.WorkflowID
		case "versionId":
			if env.VersionID == "" {
				return nil, fail(CodeRuntime, "workflow.versionId is not available at runtime.")
			}
			act["workflow.versionId"] = env.VersionID
		}
	}
	return act, nil
}

var errInputTooDeep = fail(CodeRuntime, "An input value is nested too deeply.")

// errInputInexact refuses an input whole number that cannot be read
// exactly (outside the int64 range).
var errInputInexact = fail(CodeRuntime, "An input whole number is outside the range an expression can read exactly.")

// errResultInexact refuses a result whole number outside ±2^53. Storage
// and API clients read JSON numbers as float64, which would silently round
// it, so the step fails closed instead. Like every runtime error it never
// echoes the value.
var errResultInexact = fail(CodeRuntime, "Expression result has a whole number outside ±2^53, which cannot be stored exactly; convert it with string() to keep every digit.")

// MaxExactInt is 2^53, the largest whole number magnitude a result may
// carry (every integer up to it is exact as a float64).
const MaxExactInt = 1 << 53

var errResultType = fail(CodeType, "Expression result has a type that cannot be stored (only null, bool, number, string, timestamp, list and map are allowed).")

// toNative converts a CEL value to a JSON-shaped Go value. Bytes,
// durations, types, opaque values (SecretRef) and non-string map keys fail
// closed.
func toNative(v ref.Val, depth int) (any, *Error) {
	if depth > maxResultDepth {
		return nil, fail(CodeRuntime, "Expression result is nested too deeply.")
	}
	switch x := v.(type) {
	case types.Null:
		return nil, nil
	case types.Bool:
		return bool(x), nil
	case types.Int:
		if int64(x) > MaxExactInt || int64(x) < -MaxExactInt {
			return nil, errResultInexact
		}
		return int64(x), nil
	case types.Uint:
		if uint64(x) > MaxExactInt {
			return nil, errResultInexact
		}
		return int64(x), nil
	case types.Double:
		f := float64(x)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, errResultType
		}
		return f, nil
	case types.String:
		return string(x), nil
	case types.Timestamp:
		return x.Time.UTC().Format(time.RFC3339Nano), nil
	}
	if types.IsError(v) || types.IsUnknown(v) {
		return nil, fail(CodeRuntime, "Expression failed at runtime (for example a missing field or a type mismatch).")
	}
	if m, ok := v.(traits.Mapper); ok {
		out := map[string]any{}
		it := m.Iterator()
		for it.HasNext() == types.True {
			k := it.Next()
			ks, ok := k.(types.String)
			if !ok {
				return nil, fail(CodeType, "Expression result maps must have string keys.")
			}
			nv, err := toNative(m.Get(k), depth+1)
			if err != nil {
				return nil, err
			}
			out[string(ks)] = nv
		}
		return out, nil
	}
	if l, ok := v.(traits.Lister); ok {
		out := []any{}
		it := l.Iterator()
		for it.HasNext() == types.True {
			nv, err := toNative(it.Next(), depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, nv)
		}
		return out, nil
	}
	return nil, errResultType
}

// checkRuntimeWant is the runtime half of checkWant: a dyn result that the
// publish check could not type is checked here, and fails closed.
func checkRuntimeWant(v any, sc Scope) *Error {
	ok := true
	switch sc.Want {
	case KindBoolean:
		_, ok = v.(bool)
	case KindString:
		_, ok = v.(string)
	case KindInteger:
		_, ok = v.(int64)
	case KindObject:
		_, ok = v.(map[string]any)
	case KindItems:
		_, ok = v.([]any)
	case KindSecretRef:
		ok = false
	}
	if !ok {
		return fail(CodeType, "Expression result at runtime does not match the field type ("+string(sc.Want)+").")
	}
	return nil
}

// normalizeJSON copies a JSON-decoded value into CEL-friendly Go types.
// JSON has one number type, so a whole float64 within ±2^53 becomes int64
// (item.total * 2 works on a stored 5); other numbers stay double. Go int
// widths become int64. A json.Number written as a whole number (the store
// keeps one outside ±2^53 exact) becomes an exact int64, or fails closed
// when it is outside the int64 range; any other json.Number is a double.
// A value nested deeper than maxResultDepth fails closed rather than
// binding an unnormalized value.
func normalizeJSON(v any, depth int) (any, *Error) {
	if depth > maxResultDepth {
		return nil, errInputTooDeep
	}
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			nv, err := normalizeJSON(e, depth+1)
			if err != nil {
				return nil, err
			}
			out[k] = nv
		}
		return out, nil
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			nv, err := normalizeJSON(e, depth+1)
			if err != nil {
				return nil, err
			}
			out[i] = nv
		}
		return out, nil
	case float64:
		if x == math.Trunc(x) && math.Abs(x) <= MaxExactInt {
			return int64(x), nil
		}
		return x, nil
	case float32:
		return normalizeJSON(float64(x), depth)
	case int:
		return int64(x), nil
	case int32:
		return int64(x), nil
	case uint64:
		if x > math.MaxInt64 {
			return nil, errInputInexact
		}
		return int64(x), nil
	case json.Number:
		if !strings.ContainsAny(string(x), ".eE") {
			i, err := strconv.ParseInt(string(x), 10, 64)
			if err != nil {
				return nil, errInputInexact
			}
			return i, nil
		}
		if f, err := x.Float64(); err == nil {
			return f, nil
		}
		return nil, errInputInexact
	}
	return v, nil
}
