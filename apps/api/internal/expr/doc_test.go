package expr

import (
	"testing"

	"cel.dev/cel-go/cel"
)

// TestCELPinnedCompiles checks the pinned cel-go builds a bare environment
// with no extensions and evaluates a trivial pure expression.
func TestCELPinnedCompiles(t *testing.T) {
	env, err := cel.NewEnv()
	if err != nil {
		t.Fatalf("NewEnv: %v", err)
	}
	ast, iss := env.Compile(`1 + 1 == 2`)
	if iss.Err() != nil {
		t.Fatalf("Compile: %v", iss.Err())
	}
	prg, err := env.Program(ast)
	if err != nil {
		t.Fatalf("Program: %v", err)
	}
	out, _, err := prg.Eval(cel.NoVars())
	if err != nil {
		t.Fatalf("Eval: %v", err)
	}
	if out.Value() != true {
		t.Fatalf("got %v, want true", out.Value())
	}
}
