package workflow

import (
	"fmt"
	"sync/atomic"
)

// test.ffx is a test-only node with FFX expr fields (#650 E3.2). E3.2 adds
// the publish-time checker before any production node declares an expr
// field (E3.3 adds them to data.map and flow.condition), so tests in other
// packages need a node to point the checker at.
//
// It lives outside the fftest registry (IsTestNode stays false, so the
// untagged-build guard still holds) and is visible to the parser only after
// a test calls EnableExpressionTestNode. No production code path calls it.
// A test.ffx version is never dispatched to a local evaluator.
const TestExprNodeType = "test.ffx"

var exprTestNode atomic.Pointer[testNode]

// lookupTestNode finds a test-only node: the fftest registry, then test.ffx
// when a test enabled it.
func lookupTestNode(typ string) (testNode, bool) {
	if tn, ok := testNodes[typ]; ok {
		return tn, true
	}
	if tn := exprTestNode.Load(); tn != nil && typ == TestExprNodeType {
		return *tn, true
	}
	return testNode{}, false
}

// EnableExpressionTestNode makes test.ffx parse. Tests only.
func EnableExpressionTestNode() {
	if exprTestNode.Load() != nil {
		return
	}
	exprTestNode.Store(&testNode{
		contract: NodeType{
			Type:        TestExprNodeType,
			Phase:       PhaseCore,
			Title:       "Test FFX (tests only)",
			Description: "Expression type-check fixture. Never executes.",
			Inputs: []Port{
				inheritPort("orders", PortItems, false, "Items input."),
				inheritPort("config", PortObject, false, "Object input."),
				inheritPort("loose", PortAny, false, "Any input."),
			},
			Outputs: []Port{publicObjectPort("result", "Unused.")},
			AllowedWith: []WithField{
				{Name: "when", Kind: WithKindExpr, ExprType: string(PortBoolean), Description: "Boolean condition."},
				{Name: "value", Kind: WithKindExpr, ExprType: string(PortAny), Description: "Any value."},
				{Name: "handle", Kind: WithKindExpr, ExprType: "secretRef", AcceptsSecretRef: true, Description: "Credential ref pass-through."},
				{Name: "mode", Kind: "enum", Enum: []string{"perItem", "once"}, Description: "Item mode."},
			},
			Policy: defaultNeutralPolicy(),
			Bounds: defaultNeutralBounds(),
		},
		validate: validateExprTestNode,
		eval: func(map[string]any, int) StepOutcome {
			return StepOutcome{Fail: true, Code: CodeUnsupportedNode, Message: "test.ffx never executes."}
		},
	})
}

func validateExprTestNode(n Node, path string) ErrorList {
	var errs ErrorList
	for k, v := range n.With {
		switch k {
		case "when", "value", "handle":
			if _, ok := ExpressionSource(v); !ok {
				errs = append(errs, fieldError(path+".with."+k, n.pos.Line, n.pos.Column, CodeInvalidWith, fmt.Sprintf("with.%s must be {expr: <string>}.", k)))
			}
		case "mode":
			if s, _ := v.(string); s != "perItem" && s != "once" {
				errs = append(errs, fieldError(path+".with.mode", n.pos.Line, n.pos.Column, CodeInvalidWith, `mode must be "perItem" or "once".`))
			}
		default:
			errs = append(errs, fieldError(path+".with."+k, n.pos.Line, n.pos.Column, CodeUnknownField, fmt.Sprintf("test.ffx does not allow with.%s.", k)))
		}
	}
	return errs
}
