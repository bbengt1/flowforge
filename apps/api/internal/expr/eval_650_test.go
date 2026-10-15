package expr

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"cel.dev/cel-go/cel"
)

func objScope(want Kind) Scope {
	return Scope{Mode: ModePerItem, Declared: map[string]Kind{"input": KindObject}, Wired: map[string]Kind{"input": KindObject}, Want: want}
}

func bombEnv(t *testing.T, src string) (*cel.Env, *cel.Ast) {
	t.Helper()
	env, err := cel.NewEnv(append(baseOptions(), cel.Variable("xs", cel.ListType(cel.IntType)))...)
	if err != nil {
		t.Fatal(err)
	}
	ast, iss := env.Compile(src)
	if iss != nil && iss.Err() != nil {
		t.Fatal(iss.Err())
	}
	return env, ast
}

func bigList(n int) []int64 {
	xs := make([]int64, n)
	for i := range xs {
		xs[i] = int64(i)
	}
	return xs
}

// T3 ffx_cost_bomb (runtime): a program that slips past the static
// estimate is still stopped by cel.CostLimit. The same AST built without
// ProgramOptions runs to completion, so this test fails if newProgram ever
// drops the options.
func TestFFXRuntimeCostBomb650(t *testing.T) {
	const src = `xs.map(a, xs.map(b, xs.map(c, a + b + c))).size() > 0`
	env, ast := bombEnv(t, src)
	act := map[string]any{"xs": bigList(200)}
	prg, err := newProgram(env, ast)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = prg.Eval(act)
	if err == nil {
		t.Fatal("cost bomb ran to completion under ProgramOptions")
	}
	if e := classifyEvalError(context.Background(), err); e.Code != CodeCostExceeded {
		t.Fatalf("code %s", e.Code)
	}
	bare, err := env.Program(ast)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := bare.Eval(map[string]any{"xs": bigList(40)}); err != nil {
		t.Fatalf("control: %v", err)
	}
}

// T3 ffx_interrupt_running_program: InterruptCheckFrequency lets a canceled
// context stop a comprehension that is already running.
func TestFFXInterruptRunningProgram650(t *testing.T) {
	env, ast := bombEnv(t, `xs.all(x, x >= 0)`)
	prg, err := newProgram(env, ast)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err = prg.ContextEval(ctx, map[string]any{"xs": bigList(5000)})
	if err == nil {
		t.Fatal("canceled program was not interrupted")
	}
	if e := classifyEvalError(context.Background(), err); e.Code != CodeTimeout {
		t.Fatalf("code %s (%v)", e.Code, err)
	}
}

// T3 ffx_deadline: an evaluation past its deadline reports expression-timeout.
func TestFFXDeadline650(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	_, err := Eval(ctx, `item.n > 0`, objScope(KindBoolean), Env{Item: map[string]any{"n": 1}, HasItem: true})
	if err == nil || err.Code != CodeTimeout {
		t.Fatalf("got %v", err)
	}
	if EvalDeadline != 10*time.Millisecond || StepDeadline != 2*time.Second {
		t.Fatal("deadlines drifted from #650 §4")
	}
}

// T3 ffx_regex_matches_cost (runtime): a pathological RE2 pattern on a
// max-size string stays within the limits and terminates.
func TestFFXRegexMatchesCostRuntime650(t *testing.T) {
	s := strings.Repeat("a", 16<<10-16)
	start := time.Now()
	_, err := Eval(context.Background(), `item.s.matches("^(a+)+$")`, objScope(KindBoolean), Env{Item: map[string]any{"s": s}, HasItem: true})
	if err != nil && err.Code != CodeCostExceeded && err.Code != CodeTimeout {
		t.Fatalf("got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("regex was not bounded")
	}
}

// T3 ffx_string_ext_output_cap: results are capped at MaxItemBytes.
func TestFFXStringOutputCap650(t *testing.T) {
	s := strings.Repeat("x", 9<<10)
	_, err := Eval(context.Background(), `{"a": item.s + item.s}`, objScope(KindObject), Env{Item: map[string]any{"s": s}, HasItem: true})
	if err == nil || err.Code != CodeRuntime {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(err.Message, "xxx") {
		t.Fatal("echoed value")
	}
}

// Runtime type checks for values E3.2 typed dyn.
func TestFFXRuntimeTypeCheck650(t *testing.T) {
	env := Env{Item: map[string]any{"flag": "yes", "n": int64(3), "b": []byte("x")}, HasItem: true}
	for _, tc := range []struct {
		src  string
		want Kind
	}{
		{`item.flag`, KindBoolean},
		{`item.n`, KindObject},
		{`item.missing == 1`, KindBoolean},
	} {
		_, err := Eval(context.Background(), tc.src, objScope(tc.want), env)
		if err == nil {
			t.Fatalf("%q: dyn result was accepted", tc.src)
		}
		if strings.Contains(err.Message, "yes") || strings.Contains(err.Message, tc.src) {
			t.Fatalf("%q: message echoes: %s", tc.src, err.Message)
		}
	}
	got, err := Eval(context.Background(), `{"total": item.n * 2, "at": run.clock}`, objScope(KindObject),
		Env{Item: map[string]any{"n": int64(3)}, HasItem: true, Clock: ptrTime(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))})
	if err != nil {
		t.Fatal(err)
	}
	m := got.(map[string]any)
	if m["total"] != int64(6) || m["at"] != "2026-01-02T03:04:05Z" {
		t.Fatalf("got %v", m)
	}
}

func ptrTime(t time.Time) *time.Time { return &t }

// run.clock is deterministic: the same attempt clock gives the same value,
// and a missing clock fails closed rather than reading the wall clock.
func TestFFXRunClockDeterministic650(t *testing.T) {
	clk := ptrTime(time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC))
	sc := objScope(KindBoolean)
	for i := 0; i < 3; i++ {
		v, err := Eval(context.Background(), `run.clock > timestamp("2026-10-15T11:59:59Z")`, sc, Env{Clock: clk})
		if err != nil || v != true {
			t.Fatalf("%v %v", v, err)
		}
	}
	if _, err := Eval(context.Background(), `run.clock > timestamp("2000-01-01T00:00:00Z")`, sc, Env{}); err == nil || err.Code != CodeRuntime {
		t.Fatalf("missing clock: %v", err)
	}
}

// T5 ffx_secret_use_rejected (runtime) and error_message_no_echo.
func TestFFXSecretNeverReadable650(t *testing.T) {
	sc := Scope{Mode: ModePerItem, Want: KindSecretRef, SecretRefOK: true}
	if _, err := Eval(context.Background(), `vars.token`, sc, Env{}); err == nil || err.Code != CodeSecretUse {
		t.Fatalf("got %v", err)
	}
	if _, err := Eval(context.Background(), `vars.token == "x"`, objScope(KindBoolean), Env{}); err == nil || err.Code != CodeSecretUse {
		t.Fatalf("got %v", err)
	}
}

func TestFFXRuntimeErrorNoEcho650(t *testing.T) {
	secret := "s3cr3t-value-zz"
	env := Env{Item: map[string]any{"k": secret}, HasItem: true}
	for _, src := range []string{`item.k + 1 == 2`, `item.k.nope == "s3cr3t-value-zz"`, `int(item.k) > 0`, `item.k`} {
		_, err := Eval(context.Background(), src, objScope(KindBoolean), env)
		if err == nil {
			t.Fatalf("%q passed", src)
		}
		if strings.Contains(err.Message, secret) || strings.Contains(err.Message, src) || strings.Contains(err.Message, "nope") {
			t.Fatalf("%q echoed: %s", src, err.Message)
		}
	}
}

// Every runtime program in this package is built by newProgram, which
// carries ProgramOptions. A new .Program( call anywhere else fails here.
func TestProgramsOnlyBuiltWithProgramOptions650(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	re := regexp.MustCompile(`\.Program\(`)
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if re.MatchString(line) && strings.TrimSpace(line) != "return env.Program(checked, ProgramOptions()...)" {
				t.Fatalf("%s builds a CEL program without newProgram: %s", f, strings.TrimSpace(line))
			}
		}
	}
	if len(ProgramOptions()) != 2 {
		t.Fatal("ProgramOptions must carry CostLimit and InterruptCheckFrequency")
	}
}

// Terry's E3.2 smoke: has() through the real checker carries the 'k' in m
// hint and never echoes the field name or source.
func TestPresenceTestHintRealChecker650(t *testing.T) {
	for _, src := range []string{`has(item.secretField)`, `has(item.a) && true`, `item.x.has(item.y)`} {
		_, err := Check(src, objScope(KindBoolean))
		if src == `item.x.has(item.y)` {
			continue // member call, not the macro form
		}
		if err == nil || err.Code != CodeParse || !strings.Contains(err.Message, "'k' in m") {
			t.Fatalf("%q: %v", src, err)
		}
		if strings.Contains(err.Message, "secretField") {
			t.Fatal("echoed field name")
		}
	}
}

// A nested ternary without brackets is a parse error (documented).
func TestNestedTernaryNeedsBrackets650(t *testing.T) {
	if _, err := Check(`true ? true ? 1 : 0 : 0`, objScope(KindAny)); err == nil || err.Code != CodeParse {
		t.Fatalf("unbracketed: %v", err)
	}
	if _, err := Check(`true ? (true ? 1 : 0) : 0`, objScope(KindAny)); err != nil {
		t.Fatalf("bracketed: %v", err)
	}
}
