package workflow

// Test-only node registry (#651 fixturesuite). It is EMPTY in every
// production build: entries are added only by files built with the
// `fftest` build tag (see testnode_flaky_fftest.go). Release images and
// cmd/* builds never set that tag, so an untagged parser rejects test.*
// types with the normal unknown-node-type / unsupported-node codes.

type testNode struct {
	contract NodeType
	validate func(n Node, path string) ErrorList
	eval     func(with map[string]any, attempt int) StepOutcome
}

var testNodes = map[string]testNode{}

// Referenced here so untagged lint does not flag it; callers live in
// fftest-tagged files only.
var _ = registerTestNode

func registerTestNode(tn testNode) {
	testNodes[tn.contract.Type] = tn
}

// IsTestNode reports whether typ is a registered test-only node. Always
// false in production (untagged) builds.
func IsTestNode(typ string) bool {
	_, ok := testNodes[typ]
	return ok
}

// TestNodeTypes lists registered test-only node types (empty untagged).
func TestNodeTypes() []string {
	out := make([]string, 0, len(testNodes))
	for k := range testNodes {
		out = append(out, k)
	}
	return out
}

// EvaluateTestStep runs a test-only node for a 1-based attempt number.
// The result depends only on with + attempt: no clock, no randomness.
func EvaluateTestStep(typ string, with map[string]any, attempt int) StepOutcome {
	tn, ok := testNodes[typ]
	if !ok {
		return StepOutcome{Fail: true, Code: CodeUnknownNodeType, Message: "Unknown test node type."}
	}
	return tn.eval(with, attempt)
}
