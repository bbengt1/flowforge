package expr

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"cel.dev/cel-go/cel"
	"cel.dev/cel-go/checker"
	"cel.dev/cel-go/common/ast"
	"cel.dev/cel-go/common/types"
)

// Publish-time error codes (#650 §4). Messages are fixed strings: they never
// echo expression source, identifiers taken from data, or values.
const (
	CodeParse          = "expression-parse"
	CodeType           = "expression-type"
	CodeRefUnknown     = "expression-ref-unknown"
	CodeRefNotAncestor = "expression-ref-not-ancestor"
	CodeSecretUse      = "expression-secret-use"
	CodeTooComplex     = "expression-too-complex"
)

// Runtime error codes. Reserved here so E3.3 uses the locked names; nothing
// in E3.2 evaluates an expression.
const (
	CodeCostExceeded = "expression-cost-exceeded"
	CodeTimeout      = "expression-timeout"
	CodeRuntime      = "expression-runtime"
)

// Limits (#650 §4). MaxDepth matches workflow.MaxFieldPathDepth; the size
// estimator bounds match the item caps (MaxItemBytes, MaxItemsPerPort).
const (
	MaxSourceBytes = 1 << 10
	MaxASTNodes    = 256
	MaxDepth       = 8

	// CostLimit is both the static publish budget and the runtime
	// cel.CostLimit. InterruptCheckFrequency makes a running comprehension
	// check for interruption every N iterations, so a deadline can stop a
	// program that is already running.
	CostLimit               uint64 = 1_000_000
	InterruptCheckFrequency uint   = 100

	maxStringSize = 16 << 10 // MaxItemBytes
	maxListSize   = 1000     // MaxItemsPerPort
	maxMapSize    = 1000
)

// Kind is a port or field kind, mirroring workflow.PortKind.
type Kind string

const (
	KindObject    Kind = "object"
	KindItems     Kind = "items"
	KindString    Kind = "string"
	KindInteger   Kind = "integer"
	KindBoolean   Kind = "boolean"
	KindAny       Kind = "any"
	KindSecretRef Kind = "secretRef"
)

// Modes for item scope.
const (
	ModePerItem = "perItem"
	ModeOnce    = "once"
)

// Scope is everything an expression may reference. It is built from the
// draft or version being checked; nothing outside it resolves.
type Scope struct {
	// Mode is perItem (item in scope) or once (items in scope).
	Mode string
	// Declared lists every input port on the node type.
	Declared map[string]Kind
	// Wired lists the input ports fed from an upstream node along a DAG
	// edge, or set literally on the node, with the upstream port kind.
	Wired map[string]Kind
	// Want is the declared result kind of the field. KindAny accepts any
	// non-secret type.
	Want Kind
	// SecretRefOK is true only for a field that accepts a credential ref.
	SecretRefOK bool
	// CoreNode is set for core-node fields (data.map, flow.condition).
	// trigger and items are not bound there yet, so they are refused at
	// publish with errRootNotAvailable instead of failing at runtime.
	CoreNode bool
}

// Refs are the references extracted statically from one expression.
type Refs struct {
	Inputs   []string `json:"inputs,omitempty"`
	Vars     []string `json:"vars,omitempty"`
	Run      []string `json:"run,omitempty"`
	Workflow []string `json:"workflow,omitempty"`
	Item     bool     `json:"item,omitempty"`
	Items    bool     `json:"items,omitempty"`
	Trigger  bool     `json:"trigger,omitempty"`
}

// Result is a successful check: the output type and the static refs.
type Result struct {
	Type string
	Refs Refs
	Cost uint64
}

// Error is one publish-time failure.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func fail(code, msg string) *Error { return &Error{Code: code, Message: msg} }

// errRootNotAvailable is fixed: it never echoes the expression.
var errRootNotAvailable = fail(CodeRefUnknown, "trigger and items are not available yet in core-node expressions.")

var (
	secretRefType = cel.OpaqueType("flowforge.SecretRef")
	objectType    = cel.MapType(cel.StringType, cel.DynType)
	itemsType     = cel.ListType(objectType)

	runFields      = map[string]*cel.Type{"id": cel.StringType, "startedAt": cel.TimestampType, "clock": cel.TimestampType}
	workflowFields = map[string]*cel.Type{"id": cel.StringType, "versionId": cel.StringType}

	nameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
)

// reservedRoots may not be rebound as comprehension variables, so a
// shadowed name can never hide a vars or input reference.
var reservedRoots = map[string]bool{
	"item": true, "items": true, "input": true, "run": true,
	"workflow": true, "trigger": true, "vars": true,
}

// baseOptions starts from cel.NewEnv's standard library on purpose and only
// narrows it: macros are cut to the bounded all/exists/map/filter set (no
// has, no exists_one). No ext package is added.
func baseOptions() []cel.EnvOption {
	return []cel.EnvOption{
		cel.ClearMacros(),
		cel.Macros(cel.AllMacro, cel.ExistsMacro, cel.MapMacro, cel.MapFilterMacro, cel.FilterMacro),
		cel.ParserExpressionSizeLimit(MaxSourceBytes),
	}
}

// ProgramOptions are the runtime limits every FFX program must carry
// (#650 §4). E3.3 adds the 10 ms / 2 s deadlines on top.
func ProgramOptions() []cel.ProgramOption {
	return []cel.ProgramOption{
		cel.CostLimit(CostLimit),
		cel.InterruptCheckFrequency(InterruptCheckFrequency),
	}
}

// Check parses, extracts refs, type-checks and cost-checks src against sc.
// It never evaluates anything.
func Check(src string, sc Scope) (Result, *Error) {
	r, _, _, err := compile(src, sc)
	return r, err
}

// compile is Check plus the checked AST and its environment, so the runtime
// (eval.go) evaluates exactly what publish accepted.
func compile(src string, sc Scope) (Result, *cel.Env, *cel.Ast, *Error) {
	if src == "" || strings.TrimSpace(src) == "" {
		return Result{}, nil, nil, fail(CodeParse, "Expression is empty.")
	}
	if len(src) > MaxSourceBytes {
		return Result{}, nil, nil, fail(CodeTooComplex, fmt.Sprintf("Expression source is over %d bytes.", MaxSourceBytes))
	}
	if !utf8.ValidString(src) {
		return Result{}, nil, nil, fail(CodeParse, "Expression is not valid UTF-8.")
	}
	base, err := cel.NewEnv(baseOptions()...)
	if err != nil {
		return Result{}, nil, nil, fail(CodeType, "Expression environment is unavailable.")
	}
	parsed, iss := base.Parse(src)
	if iss != nil && iss.Err() != nil {
		return Result{}, nil, nil, fail(CodeParse, "Expression does not parse.")
	}
	w := walker{sc: sc, iter: map[string]bool{}}
	root := parsed.NativeRep().Expr()
	w.collectIterVars(root)
	if w.err == nil {
		w.walk(root, 1, "")
	}
	if w.err != nil {
		return Result{}, nil, nil, w.err
	}
	if w.nodes > MaxASTNodes {
		return Result{}, nil, nil, fail(CodeTooComplex, fmt.Sprintf("Expression has more than %d nodes.", MaxASTNodes))
	}
	if w.maxDepth > MaxDepth {
		return Result{}, nil, nil, fail(CodeTooComplex, fmt.Sprintf("Expression nesting is deeper than %d.", MaxDepth))
	}
	// vars.* is a SecretRef: pass-through only. The whole expression must be
	// exactly vars.<name>, into a field that accepts a credential ref.
	if len(w.vars) > 0 {
		if !isVarsSelect(root) {
			return Result{}, nil, nil, fail(CodeSecretUse, "vars can only be passed through whole (vars.<name>); it cannot be read, compared, combined or output.")
		}
		if !sc.SecretRefOK {
			return Result{}, nil, nil, fail(CodeSecretUse, "This field does not accept a credential reference, so vars cannot be used here.")
		}
	}
	for _, p := range w.patterns {
		if _, err := regexp.Compile(p); err != nil {
			return Result{}, nil, nil, fail(CodeType, "A matches() pattern is not a valid RE2 regular expression.")
		}
	}

	env, err := base.Extend(w.declarations()...)
	if err != nil {
		return Result{}, nil, nil, fail(CodeType, "Expression environment is unavailable.")
	}
	checked, iss := env.Check(parsed)
	if iss != nil && iss.Err() != nil {
		return Result{}, nil, nil, fail(CodeType, "Expression does not type-check against the port types in scope.")
	}
	out := checked.OutputType()
	if e := checkWant(out, sc); e != nil {
		return Result{}, nil, nil, e
	}
	est, err := env.EstimateCost(checked, sizeEstimator{})
	if err != nil || est.Max > CostLimit {
		return Result{}, nil, nil, fail(CodeTooComplex, "Expression's estimated cost is over the budget.")
	}
	return Result{Type: out.String(), Refs: w.refs(), Cost: est.Max}, env, checked, nil
}

func isVarsSelect(e ast.Expr) bool {
	if e.Kind() != ast.SelectKind {
		return false
	}
	s := e.AsSelect()
	return !s.IsTestOnly() && s.Operand().Kind() == ast.IdentKind && s.Operand().AsIdent() == "vars"
}

func checkWant(out *cel.Type, sc Scope) *Error {
	if out.IsExactType(secretRefType) {
		if !sc.SecretRefOK {
			return fail(CodeSecretUse, "This field does not accept a credential reference.")
		}
		return nil
	}
	if sc.Want == KindSecretRef {
		return fail(CodeType, "This field takes a credential reference (vars.<name>).")
	}
	if out.Kind() == types.DynKind || sc.Want == KindAny || sc.Want == "" {
		// dyn is checked at runtime (E3.3) against the field kind.
		return nil
	}
	ok := false
	switch sc.Want {
	case KindBoolean:
		ok = out.Kind() == types.BoolKind
	case KindString:
		ok = out.Kind() == types.StringKind
	case KindInteger:
		ok = out.Kind() == types.IntKind
	case KindObject:
		ok = out.Kind() == types.MapKind
	case KindItems:
		ok = out.Kind() == types.ListKind
	}
	if !ok {
		return fail(CodeType, fmt.Sprintf("Expression result type does not match the field type (%s).", sc.Want))
	}
	return nil
}

// celType maps a port kind to its CEL type.
func celType(k Kind) *cel.Type {
	switch k {
	case KindObject:
		return objectType
	case KindItems:
		return itemsType
	case KindString:
		return cel.StringType
	case KindInteger:
		return cel.IntType
	case KindBoolean:
		return cel.BoolType
	case KindSecretRef:
		return secretRefType
	default:
		return cel.DynType
	}
}

type walker struct {
	sc       Scope
	iter     map[string]bool
	nodes    int
	maxDepth int
	err      *Error

	inputs, vars, run, wf map[string]bool
	item, items, trigger  bool
	patterns              []string
}

func (w *walker) setErr(e *Error) {
	if w.err == nil {
		w.err = e
	}
}

func (w *walker) collectIterVars(e ast.Expr) {
	visit := ast.NewExprVisitor(func(x ast.Expr) {
		if x.Kind() != ast.ComprehensionKind {
			return
		}
		c := x.AsComprehension()
		for _, v := range []string{c.IterVar(), c.IterVar2()} {
			if v == "" {
				continue
			}
			if reservedRoots[v] {
				w.setErr(fail(CodeParse, "A reserved name (item, items, input, run, workflow, trigger, vars) cannot be a loop variable."))
				return
			}
			w.iter[v] = true
		}
		w.iter[c.AccuVar()] = true
	})
	ast.PostOrderVisit(e, visit)
}

func add(m *map[string]bool, k string) {
	if *m == nil {
		*m = map[string]bool{}
	}
	(*m)[k] = true
}

// chainableOps are the only operators whose left-deep chains count as one
// nesting level (a && b && c, a + b + c). Nested ternaries, ! chains and
// every other call count each level (#650 E3.2 L2).
var chainableOps = map[string]bool{
	"_&&_": true,
	"_||_": true,
	"_+_":  true,
	"_*_":  true,
}

// walk counts nodes, measures nesting and extracts refs. A chain of the same
// chainable operator (a + b + c) counts as one nesting level, so depth
// measures real nesting rather than the parser's left-deep shape.
func (w *walker) walk(e ast.Expr, depth int, parentFn string) {
	if w.err != nil {
		return
	}
	w.nodes++
	if w.nodes > MaxASTNodes+1 {
		return
	}
	if depth > w.maxDepth {
		w.maxDepth = depth
	}
	switch e.Kind() {
	case ast.IdentKind:
		w.ident(e.AsIdent())
	case ast.SelectKind:
		s := e.AsSelect()
		if s.IsTestOnly() {
			w.setErr(fail(CodeParse, "Presence tests are not supported; use 'k' in m."))
			return
		}
		op := s.Operand()
		if op.Kind() == ast.IdentKind && !w.iter[op.AsIdent()] {
			if w.rootSelect(op.AsIdent(), s.FieldName()) {
				w.nodes++
				if depth+1 > w.maxDepth {
					w.maxDepth = depth + 1
				}
				return
			}
		}
		w.walk(op, depth+1, "")
	case ast.CallKind:
		c := e.AsCall()
		fn := c.FunctionName()
		if fn == "has" && !c.IsMemberFunction() {
			// has() is not enabled (bounded macros only); say so, with the
			// supported form, instead of a generic type error.
			w.setErr(fail(CodeParse, "Presence tests are not supported; use 'k' in m."))
			return
		}
		next := depth + 1
		if chainableOps[fn] && fn == parentFn && !c.IsMemberFunction() {
			next = depth
		}
		if c.IsMemberFunction() {
			w.walk(c.Target(), next, "")
		}
		if args := c.Args(); fn == "matches" && len(args) > 0 {
			pat := args[len(args)-1]
			if pat.Kind() == ast.LiteralKind {
				if s, ok := pat.AsLiteral().Value().(string); ok {
					w.patterns = append(w.patterns, s)
				}
			}
		}
		for _, a := range c.Args() {
			w.walk(a, next, fn)
		}
	case ast.ComprehensionKind:
		c := e.AsComprehension()
		for _, x := range []ast.Expr{c.IterRange(), c.AccuInit(), c.LoopCondition(), c.LoopStep(), c.Result()} {
			w.walk(x, depth+1, "")
		}
	case ast.ListKind:
		for _, x := range e.AsList().Elements() {
			w.walk(x, depth+1, "")
		}
	case ast.MapKind:
		for _, en := range e.AsMap().Entries() {
			me := en.AsMapEntry()
			w.walk(me.Key(), depth+1, "")
			w.walk(me.Value(), depth+1, "")
		}
	case ast.StructKind:
		w.setErr(fail(CodeType, "Message construction is not supported."))
	case ast.LiteralKind, ast.UnspecifiedExprKind:
	}
}

func (w *walker) ident(name string) {
	if w.iter[name] {
		return
	}
	if w.sc.CoreNode && (name == "trigger" || name == "items") {
		w.setErr(errRootNotAvailable)
		return
	}
	switch name {
	case "item":
		if w.sc.Mode == ModeOnce {
			w.setErr(fail(CodeRefUnknown, "item is only in scope in perItem mode; use items in once mode."))
			return
		}
		w.item = true
	case "items":
		if w.sc.Mode != ModeOnce {
			w.setErr(fail(CodeRefUnknown, "items is only in scope in once mode; use item in perItem mode."))
			return
		}
		w.items = true
	case "trigger":
		w.trigger = true
	case "input", "run", "workflow", "vars":
		w.setErr(fail(CodeRefUnknown, name+" must be followed by a field name."))
	default:
		w.setErr(fail(CodeRefUnknown, "Expression references a name that is not in scope."))
	}
}

// rootSelect handles root.field for the qualified roots. It returns false
// when root is not one of them, so the caller walks the operand normally.
func (w *walker) rootSelect(root, field string) bool {
	switch root {
	case "input":
		if _, ok := w.sc.Declared[field]; !ok {
			w.setErr(fail(CodeRefUnknown, "Expression references an input port this node does not declare."))
			return true
		}
		if _, ok := w.sc.Wired[field]; !ok {
			w.setErr(fail(CodeRefNotAncestor, "Expression references an input port that no upstream step feeds."))
			return true
		}
		add(&w.inputs, field)
	case "run":
		if _, ok := runFields[field]; !ok {
			w.setErr(fail(CodeRefUnknown, "run only has id, startedAt and clock."))
			return true
		}
		add(&w.run, field)
	case "workflow":
		if _, ok := workflowFields[field]; !ok {
			w.setErr(fail(CodeRefUnknown, "workflow only has id and versionId."))
			return true
		}
		add(&w.wf, field)
	case "vars":
		if !nameRE.MatchString(field) {
			w.setErr(fail(CodeRefUnknown, "Variable names are letters, digits and underscore, up to 64 characters."))
			return true
		}
		add(&w.vars, field)
	default:
		return false
	}
	return true
}

func (w *walker) declarations() []cel.EnvOption {
	var out []cel.EnvOption
	if w.item {
		out = append(out, cel.Variable("item", objectType))
	}
	if w.items {
		out = append(out, cel.Variable("items", itemsType))
	}
	if w.trigger {
		out = append(out, cel.Variable("trigger", objectType))
	}
	for p := range w.inputs {
		out = append(out, cel.Variable("input."+p, celType(w.sc.Wired[p])))
	}
	for f := range w.run {
		out = append(out, cel.Variable("run."+f, runFields[f]))
	}
	for f := range w.wf {
		out = append(out, cel.Variable("workflow."+f, workflowFields[f]))
	}
	for v := range w.vars {
		out = append(out, cel.Variable("vars."+v, secretRefType))
	}
	return out
}

func sortedKeys(m map[string]bool) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (w *walker) refs() Refs {
	return Refs{
		Inputs: sortedKeys(w.inputs), Vars: sortedKeys(w.vars),
		Run: sortedKeys(w.run), Workflow: sortedKeys(w.wf),
		Item: w.item, Items: w.items, Trigger: w.trigger,
	}
}

// sizeEstimator bounds every variable-length value by the item caps, so
// the static estimate is finite: strings and bytes by MaxItemBytes, lists
// by MaxItemsPerPort and maps by the same count.
type sizeEstimator struct{}

func (sizeEstimator) EstimateSize(n checker.AstNode) *checker.SizeEstimate {
	if s := n.ComputedSize(); s != nil {
		return s
	}
	switch n.Type().Kind() {
	case types.StringKind, types.BytesKind, types.DynKind:
		// A dyn value is bounded by its item: at most MaxItemBytes long
		// as a string, which is also above the list and map bounds.
		return &checker.SizeEstimate{Min: 0, Max: maxStringSize}
	case types.ListKind:
		return &checker.SizeEstimate{Min: 0, Max: maxListSize}
	case types.MapKind:
		return &checker.SizeEstimate{Min: 0, Max: maxMapSize}
	}
	return nil
}

func (sizeEstimator) EstimateCallCost(string, string, *checker.AstNode, []checker.AstNode) *checker.CallEstimate {
	return nil
}
