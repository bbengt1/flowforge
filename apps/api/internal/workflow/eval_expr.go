package workflow

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/expr"
)

// RunContext is what a worker knows about the attempt it is evaluating
// (#650 E3.3). Clock is execution_steps.eval_clock: set once when the
// attempt starts and read as run.clock, so re-evaluating an attempt gives
// the same result. A retry is a new row with a new clock.
type RunContext struct {
	Ctx        context.Context
	NodeID     string
	RunID      string
	WorkflowID string
	VersionID  string
	StartedAt  time.Time
	Clock      *time.Time
}

// ReservedOutputPrefix marks engine-owned output keys (the E3.1 items
// summary is __ff_items). An expression result may not write one.
const ReservedOutputPrefix = "__ff_"

func hasExprField(n Node) bool {
	for _, f := range ExpressionFields(n.Type) {
		if _, ok := n.With[f.Name]; ok {
			return true
		}
	}
	return false
}

func exprFieldError(rc *RunContext, field, code, msg string) ErrorList {
	node := ""
	if rc != nil {
		node = rc.NodeID
	}
	return ErrorList{{
		Path:    "with." + field + ".expr",
		NodeID:  node,
		Code:    code,
		Message: fmt.Sprintf("Node %q with.%s: %s", node, field, msg),
	}}
}

// evalFieldExpr evaluates one catalog-declared expr field at runtime. The
// scope is rebuilt from the catalog and the ports actually delivered, so
// it is never wider than what publish checked. item is bound to the
// primary input when that value is an object.
func evalFieldExpr(nodeType, field string, with, inputs map[string]any, item any, rc *RunContext) (any, ErrorList) {
	var decl *WithField
	for _, f := range ExpressionFields(nodeType) {
		if f.Name == field {
			f := f
			decl = &f
		}
	}
	if decl == nil {
		return nil, exprFieldError(rc, field, CodeExpressionForbidden, "This field does not take an expression.")
	}
	src, ok := ExpressionSource(with[field])
	if !ok {
		return nil, exprFieldError(rc, field, CodeExpressionParse, "must be {expr: <string>}.")
	}
	if rc == nil {
		// Fail closed: no attempt context means no run.clock.
		return nil, exprFieldError(rc, field, CodeExpressionRuntime, "Expressions are only evaluated inside a run attempt.")
	}
	nt, _ := lookupNode(nodeType)
	declared := map[string]expr.Kind{}
	wired := map[string]expr.Kind{}
	for _, p := range nt.Inputs {
		declared[p.Name] = expr.Kind(p.Kind)
		if _, ok := inputs[p.Name]; ok {
			wired[p.Name] = expr.Kind(p.Kind)
		}
	}
	want := expr.Kind(decl.ExprType)
	if want == "" {
		want = expr.KindAny
	}
	env := expr.Env{
		Inputs: inputs, RunID: rc.RunID, StartedAt: rc.StartedAt, Clock: rc.Clock,
		WorkflowID: rc.WorkflowID, VersionID: rc.VersionID,
	}
	if m, ok := item.(map[string]any); ok {
		env.Item, env.HasItem = m, true
	}
	ctx := rc.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	v, err := expr.Eval(ctx, src, expr.Scope{
		Mode: expr.ModePerItem, Declared: declared, Wired: wired, Want: want, SecretRefOK: decl.AcceptsSecretRef,
	}, env)
	if err != nil {
		return nil, exprFieldError(rc, field, err.Code, err.Message)
	}
	return v, nil
}

func inputClass(v any) string {
	class, _ := classifyLiteral(redactValue(v))
	if class == ClassSecret || class == "" {
		if class == ClassSecret {
			return ClassConfidential
		}
		return ClassPublic
	}
	return class
}

func evalConditionExpr(with, inputs map[string]any, rc *RunContext) (*EvalResult, ErrorList) {
	value, ok := inputs["value"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeRequiredInput, "flow.condition requires input value.")}
	}
	if encodedBytes(value) > MaxPortBytes {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeOutputTooLarge, fmt.Sprintf("value exceeds the %d byte limit.", MaxPortBytes))}
	}
	got, errs := evalFieldExpr("flow.condition", "expr", with, inputs, value, rc)
	if len(errs) > 0 {
		return nil, errs
	}
	matched, ok := got.(bool)
	if !ok {
		return nil, exprFieldError(rc, "expr", CodeExpressionType, "Expression result at runtime is not a boolean.")
	}
	class := inputClass(value)
	res := conditionRoute(value, matched)
	res.Classification = class
	res.Audit = map[string]any{"op": "expr", "matched": matched, "classification": class}
	return res, nil
}

func evalDataMapExpr(with, inputs map[string]any, rc *RunContext) (*EvalResult, ErrorList) {
	rawIn, ok := inputs["input"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeRequiredInput, "data.map requires input input.")}
	}
	src, ok := rawIn.(map[string]any)
	if !ok {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeInvalidType, "data.map input must be an object.")}
	}
	if encodedBytes(src) > MaxPortBytes {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeOutputTooLarge, fmt.Sprintf("input exceeds the %d byte limit.", MaxPortBytes))}
	}
	got, errs := evalFieldExpr("data.map", "expr", with, inputs, src, rc)
	if len(errs) > 0 {
		return nil, errs
	}
	out, ok := got.(map[string]any)
	if !ok {
		return nil, exprFieldError(rc, "expr", CodeExpressionType, "Expression result at runtime is not an object.")
	}
	for k := range out {
		if strings.HasPrefix(k, ReservedOutputPrefix) {
			return nil, exprFieldError(rc, "expr", CodeExpressionRuntime, "Expression result uses a reserved engine key.")
		}
	}
	if encodedBytes(out) > MaxPortBytes {
		return nil, exprFieldError(rc, "expr", CodeOutputTooLarge, fmt.Sprintf("Expression result exceeds the %d byte limit.", MaxPortBytes))
	}
	if aggregationItems(out) > MaxAggregationItems {
		return nil, exprFieldError(rc, "expr", CodeAggregationLimit, fmt.Sprintf("Expression result exceeds the aggregation limit of %d fields.", MaxAggregationItems))
	}
	// The result takes the highest classification of its source (#650
	// classification inheritance), never lower than what it read.
	class := inputClass(src)
	return &EvalResult{
		Outputs:        map[string]any{"result": out},
		Classification: class,
		Audit:          map[string]any{"mappedFields": len(out), "classification": class, "mode": "expr"},
	}, nil
}
