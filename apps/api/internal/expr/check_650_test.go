package expr

import (
	"errors"
	"math/rand"
	"strings"
	"testing"

	"cel.dev/cel-go/cel"
)

// #650 E3.2 publish-time FFX tests: T2, T3 (publish half), T5 (publish half).

func perItem() Scope {
	return Scope{
		Mode:     ModePerItem,
		Declared: map[string]Kind{"orders": KindItems, "config": KindObject, "loose": KindAny},
		Wired:    map[string]Kind{"orders": KindItems, "config": KindObject},
		Want:     KindAny,
	}
}

func once() Scope {
	sc := perItem()
	sc.Mode = ModeOnce
	return sc
}

func wantCode(t *testing.T, src string, sc Scope, code string) {
	t.Helper()
	_, err := Check(src, sc)
	if err == nil {
		t.Fatalf("%q: accepted, want %s", src, code)
	}
	if err.Code != code {
		t.Fatalf("%q: code %s (%s), want %s", src, err.Code, err.Message, code)
	}
}

func wantOK(t *testing.T, src string, sc Scope) Result {
	t.Helper()
	r, err := Check(src, sc)
	if err != nil {
		t.Fatalf("%q: %s %s", src, err.Code, err.Message)
	}
	return r
}

func TestFFXAccepts650(t *testing.T) {
	for _, c := range []struct {
		src, typ string
		sc       Scope
	}{
		{`item.total > 1000`, "bool", perItem()},
		{`item.name.startsWith("a") && size(item.tags) < 5`, "bool", perItem()},
		{`input.orders.filter(o, o.total > 10).map(o, o.id)`, "list(dyn)", perItem()},
		{`items.all(x, x.total > 10)`, "bool", once()},
		{`items.exists(x, x.ok == true)`, "bool", once()},
		{`input.config`, "map(string, dyn)", perItem()},
		{`run.clock > run.startedAt`, "bool", perItem()},
		{`workflow.versionId + "/" + run.id`, "string", perItem()},
		{`trigger.source == "api"`, "bool", perItem()},
		{`timestamp("2026-01-01T00:00:00Z") < run.clock`, "bool", perItem()},
		{`int(item.total) * 2`, "int", perItem()},
	} {
		r := wantOK(t, c.src, c.sc)
		if r.Type != c.typ {
			t.Fatalf("%q: type %s want %s", c.src, r.Type, c.typ)
		}
	}
}

func TestFFXStaticRefs650(t *testing.T) {
	r := wantOK(t, `input.orders.exists(o, o.total > 1) && run.clock > run.startedAt && item.ok == true && trigger.x == 1`, perItem())
	if strings.Join(r.Refs.Inputs, ",") != "orders" || strings.Join(r.Refs.Run, ",") != "clock,startedAt" || !r.Refs.Item || !r.Refs.Trigger || r.Refs.Items {
		t.Fatalf("refs = %+v", r.Refs)
	}
	sc := perItem()
	sc.SecretRefOK = true
	r = wantOK(t, `vars.deployKey`, sc)
	if strings.Join(r.Refs.Vars, ",") != "deployKey" || r.Type != "flowforge.SecretRef" {
		t.Fatalf("vars refs = %+v type %s", r.Refs, r.Type)
	}
}

func TestFFXRefErrors650(t *testing.T) {
	wantCode(t, `input.missing.x == 1`, perItem(), CodeRefUnknown)
	wantCode(t, `input.loose == 1`, perItem(), CodeRefNotAncestor)
	wantCode(t, `steps.fetch.result`, perItem(), CodeRefUnknown)
	wantCode(t, `run.secret`, perItem(), CodeRefUnknown)
	wantCode(t, `workflow.digest`, perItem(), CodeRefUnknown)
	wantCode(t, `items.size() > 0`, perItem(), CodeRefUnknown)
	wantCode(t, `item.ok`, once(), CodeRefUnknown)
	wantCode(t, `input["orders"]`, perItem(), CodeRefUnknown)
	wantCode(t, `[1].all(vars, vars > 0)`, perItem(), CodeParse)
}

// T2 ffx_no_io_functions: a parse-reject table. Every I/O, env, time,
// random, reflection or encoding helper is unknown in the closed env.
func TestFFXNoIOFunctions650(t *testing.T) {
	for _, src := range []string{
		`env("HOME")`, `getenv("HOME")`, `readFile("/etc/passwd")`, `open("/etc/passwd")`,
		`http.get("https://example.com")`, `fetch("https://example.com")`, `exec("id")`,
		`now()`, `time.now()`, `rand()`, `random()`, `uuid()`, `os.Getenv("X")`,
		`type(item) == map`, `dyn(item).getClass()`, `eval("1")`,
		`sys.exit(1)`, `net.dial("tcp", "x")`, `item.name.call()`,
		`base64.encode(b"x")`, `base64.decode("eA==")`, `item.name.encode()`,
		`strings.quote(item.name)`, `item.name.format([1])`, `math.greatest(1, 2)`,
		`sets.contains([1], [1])`, `item.name.lowerAscii()`, `optional.of(1)`,
		`has(item.x)`, `[1].exists_one(x, x == 1)`,
	} {
		if _, err := Check(src, perItem()); err == nil {
			t.Errorf("%q: accepted", src)
		}
	}
}

// T2 ffx_no_encoders: ext.Encoders is never enabled; base64 must not exist.
func TestFFXNoEncoders650(t *testing.T) {
	for _, src := range []string{`base64.encode(b"x")`, `base64.decode("eA==")`, `string(base64.decode("eA=="))`} {
		_, err := Check(src, perItem())
		if err == nil || (err.Code != CodeType && err.Code != CodeRefUnknown) {
			t.Fatalf("%q: %v", src, err)
		}
	}
}

// T2 ffx_env_is_closed: a random identifier or function never resolves.
func FuzzFFXEnvIsClosed650(f *testing.F) {
	for _, s := range []string{"env", "steps", "secrets", "process", "self", "this", "global"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, name string) {
		if !nameRE.MatchString(name) || reservedRoots[name] || celKeyword(name) {
			return
		}
		for _, src := range []string{name, name + "(1)", name + ".x", "item." + name + "()"} {
			if r, err := Check(src, perItem()); err == nil && src != "item."+name+"()" {
				t.Fatalf("%q resolved to %s", src, r.Type)
			}
		}
	})
}

func celKeyword(s string) bool {
	switch s {
	case "true", "false", "null", "in", "as", "break", "const", "continue", "else", "for", "function", "if",
		"import", "let", "loop", "package", "namespace", "return", "var", "void", "while",
		"int", "uint", "double", "string", "bytes", "bool", "list", "map", "type", "dyn", "duration", "timestamp", "size", "matches",
		"contains", "startsWith", "endsWith", "getDate", "getDayOfMonth", "getDayOfWeek", "getDayOfYear", "getFullYear",
		"getHours", "getMilliseconds", "getMinutes", "getMonth", "getSeconds", "null_type":
		return true
	}
	return false
}

func TestFFXEnvIsClosedSeeds650(t *testing.T) {
	for _, n := range []string{"env", "steps", "secrets", "process", "self", "now", "rand"} {
		for _, src := range []string{n, n + "(1)", n + ".x"} {
			if _, err := Check(src, perItem()); err == nil {
				t.Fatalf("%q resolved", src)
			}
		}
	}
}

// T2 ffx_typecheck_fuzz: the checker never panics and every rejection
// carries a publish code.
func FuzzFFXTypecheck650(f *testing.F) {
	for _, s := range []string{`item.total > 1`, `items.all(x, x.a)`, `vars.k`, `"a".matches("(")`, `[[[[[[[[1]]]]]]]]`, `1 +`, "\x00", `input.orders`} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, src string) {
		for _, sc := range []Scope{perItem(), once()} {
			_, err := Check(src, sc)
			if err != nil && !publishCode(err.Code) {
				t.Fatalf("%q: non-publish code %s", src, err.Code)
			}
		}
	})
}

func publishCode(c string) bool {
	switch c {
	case CodeParse, CodeType, CodeRefUnknown, CodeRefNotAncestor, CodeSecretUse, CodeTooComplex:
		return true
	}
	return false
}

func TestFFXTypecheckRandom650(t *testing.T) {
	rng := rand.New(rand.NewSource(650))
	atoms := []string{"item", ".", "x", "(", ")", "[", "]", "1", "+", "&&", "\"s\"", "items", ",", "vars", "input", "orders", "all", "?", ":", "==", "!", "-", "matches"}
	for i := 0; i < 3000; i++ {
		var b strings.Builder
		for j := rng.Intn(12); j >= 0; j-- {
			b.WriteString(atoms[rng.Intn(len(atoms))])
		}
		if _, err := Check(b.String(), perItem()); err != nil && !publishCode(err.Code) {
			t.Fatalf("%q: %s", b.String(), err.Code)
		}
	}
}

func TestFFXTypeMismatch650(t *testing.T) {
	sc := perItem()
	sc.Want = KindBoolean
	wantCode(t, `"yes"`, sc, CodeType)
	wantCode(t, `1 + "a"`, perItem(), CodeType)
	wantCode(t, `input.config > 1`, perItem(), CodeType)
	wantOK(t, `item.flag`, sc) // dyn: checked at runtime in E3.3
	sc.Want = KindItems
	wantOK(t, `input.orders.filter(o, o.ok == true)`, sc)
	wantCode(t, `"x".matches("(")`, perItem(), CodeType)
	wantCode(t, `1 +`, perItem(), CodeParse)
	wantCode(t, ``, perItem(), CodeParse)
}

// T3 (publish half): size, node, nesting and cost caps.
func TestFFXLimits650(t *testing.T) {
	wantCode(t, `"`+strings.Repeat("a", MaxSourceBytes)+`"`, perItem(), CodeTooComplex)
	wantOK(t, `"`+strings.Repeat("a", MaxSourceBytes-2)+`"`, perItem())
	wantCode(t, strings.Repeat("[", 9)+"1"+strings.Repeat("]", 9), perItem(), CodeTooComplex)
	wantOK(t, strings.Repeat("[", 7)+"1"+strings.Repeat("]", 7), perItem())
	wantCode(t, `item.a.b.c.d.e.f.g.h`, perItem(), CodeTooComplex)
	terms := make([]string, 130)
	for i := range terms {
		terms[i] = "1"
	}
	wantCode(t, strings.Join(terms, "+"), perItem(), CodeTooComplex)
	wantOK(t, strings.Join(terms[:20], "+"), perItem())
}

// T3 ffx_cost_bomb: nested comprehensions over capped lists are rejected
// at publish by the static estimate.
func TestFFXCostBomb650(t *testing.T) {
	wantCode(t, `items.all(x, items.exists(y, x.id == y.id))`, once(), CodeTooComplex)
	wantCode(t, `input.orders.all(x, input.orders.all(y, x.n < y.n))`, perItem(), CodeTooComplex)
	wantOK(t, `items.all(x, x.total > 10)`, once())
}

// T3/T5 ffx_regex_matches_cost: matches itself is costed. One bounded
// matches per item passes; matches inside a loop over a capped list is
// over budget at publish, and at runtime cel.CostLimit stops it.
func TestFFXRegexMatchesCost650(t *testing.T) {
	r := wantOK(t, `item.name.matches("^(a+)+$")`, perItem())
	if r.Cost == 0 || r.Cost > CostLimit {
		t.Fatalf("matches cost %d", r.Cost)
	}
	wantCode(t, `items.all(x, x.name.matches("^(a|aa)+$"))`, once(), CodeTooComplex)
	wantCode(t, `input.orders.exists(o, string(o.note).matches("(x+x+)+y"))`, perItem(), CodeTooComplex)

	// Runtime half of the same limit: the program options every FFX
	// program carries stop a running matches loop on cost.
	env, err := cel.NewEnv(append(baseOptions(), cel.Variable("names", cel.ListType(cel.StringType)))...)
	if err != nil {
		t.Fatal(err)
	}
	ast, iss := env.Compile(`names.all(n, n.matches("^(a|aa)+$"))`)
	if iss.Err() != nil {
		t.Fatal(iss.Err())
	}
	prg, err := env.Program(ast, ProgramOptions()...)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 1000)
	for i := range names {
		names[i] = strings.Repeat("a", 16<<10)
	}
	_, _, err = prg.Eval(map[string]any{"names": names})
	if err == nil || !strings.Contains(err.Error(), "cost limit exceeded") {
		t.Fatalf("runtime matches loop: err=%v", err)
	}
}

func TestFFXProgramOptionsFixed650(t *testing.T) {
	if len(ProgramOptions()) != 2 || CostLimit == 0 || InterruptCheckFrequency == 0 {
		t.Fatal("CostLimit and InterruptCheckFrequency must both be set")
	}
}

// T5 ffx_secret_use_rejected (publish half): vars is pass-through only.
func TestFFXSecretUseRejected650(t *testing.T) {
	ok := perItem()
	ok.SecretRefOK = true
	ok.Want = KindSecretRef
	wantOK(t, `vars.deployKey`, ok)
	for _, src := range []string{
		`vars.k == "x"`, `vars.k + "x"`, `string(vars.k)`, `size(vars.k)`, `[vars.k]`, `{"a": vars.k}`,
		`vars.k.startsWith("a")`, `item.ok ? vars.k : vars.j`, `vars.k.matches("a")`, `vars.k != vars.j`,
	} {
		wantCode(t, src, ok, CodeSecretUse)
	}
	wantCode(t, `vars.k`, perItem(), CodeSecretUse) // field takes no credential ref
	wantCode(t, `vars`, ok, CodeRefUnknown)
	wantCode(t, `item.name`, ok, CodeType) // credential field needs vars.<name>
}

// T5 error_message_no_echo: no message repeats source text or literals.
func TestFFXErrorMessageNoEcho650(t *testing.T) {
	const marker = "zq7SECRETzq7"
	for _, src := range []string{
		`"` + marker + `" + 1`, marker + `()`, `item.` + marker + ` +`, `vars.` + marker + ` == "x"`,
		`"a".matches("(` + marker + `")`, `input.` + marker, `"` + strings.Repeat(marker, 120) + `"`,
	} {
		_, err := Check(src, perItem())
		if err == nil {
			t.Fatalf("%q accepted", src)
		}
		if strings.Contains(err.Message, marker) || len(err.Message) > 256 {
			t.Fatalf("message echoes or is too long: %q", err.Message)
		}
		var e error = err
		if !errors.As(e, &err) {
			t.Fatal("not an *Error")
		}
	}
}
