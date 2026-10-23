package workflow

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/jsonnum"
)

// #650 E3.4: flow.switch, data.filter, data.sort and data.merge.
//
// Items travel inside the port value as {"items": [...]}, under the same
// 16 KiB port cap as every other core node. Writing an item table for
// these nodes is a later slice. A plain object reads as a one-item list
// and a bare JSON array is accepted as the list itself.

// Runtime codes for the E3.4 nodes. Messages never echo item values.
const (
	CodeSwitchNoMatch        = "switch-no-match"
	CodeSortMixedTypes       = "sort-mixed-types"
	CodeSortKeyMissing       = "sort-key-missing"
	CodeMergeKeyMissing      = "merge-key-missing"
	CodeMergeDuplicateKey    = "merge-duplicate-key"
	CodeMergeLengthMismatch  = "merge-length-mismatch"
	MaxSwitchCases           = 16
	ItemsField               = "items"
	switchCaseNameMaxLen     = 64
	sortTypeString           = "string"
	sortTypeNumber           = "number"
	sortTypeTimestamp        = "timestamp"
	mergeModeAppend          = "append"
	mergeModeZip             = "zip"
	mergeModeByKey           = "byKey"
	switchDefaultDescription = "Inbound value when no case matched."
)

var (
	switchCaseNameRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*$`)
	sortTypes        = []string{sortTypeString, sortTypeNumber, sortTypeTimestamp}
	sortOrders       = []string{"asc", "desc"}
	mergeModes       = []string{mergeModeAppend, mergeModeZip, mergeModeByKey}
	// Port names a switch case may not take: the routing key, the
	// onError port, and anything that looks like an engine key.
	reservedSwitchPorts = map[string]bool{"port": true, ErrorPortName: true}
)

func itemsPolicy() *RedactionPolicy {
	return &RedactionPolicy{
		AuditFields:   []string{"inCount", "outCount", "classification"},
		RedactInputs:  true,
		RedactOutputs: true,
		Strategy:      "mask-classified",
	}
}

func flowSwitchContract() NodeType {
	return NodeType{
		Type:        "flow.switch",
		Phase:       PhaseCore,
		Title:       "Switch",
		Description: "Ordered declarative cases. The first matching case routes the inbound value to the output port named by that case; otherwise it goes to the default port. Exactly one port fires. Output ports are the case names plus default.",
		Inputs:      []Port{inheritPort("value", PortAny, true, "Value to route.")},
		// Outputs are per node: one per case name, plus default.
		Outputs:      []Port{},
		RequiredWith: []string{"cases", "default"},
		AllowedWith: []WithField{
			{Name: "path", Kind: "string", Description: "Optional dotted identifier path into value that every case compares. No expressions."},
			{Name: "cases", Kind: "array", Required: true, Description: fmt.Sprintf("1 to %d ordered {name, op, compare} cases. name is the output port; op is a flow.condition operator.", MaxSwitchCases)},
			{Name: "default", Kind: "string", Required: true, Description: "Output port taken when no case matches. Required."},
		},
		Policy: defaultNeutralPolicy(),
		Bounds: defaultNeutralBounds(),
		Redaction: &RedactionPolicy{
			AuditFields:   []string{"port", "caseIndex", "classification"},
			RedactInputs:  true,
			RedactOutputs: true,
			Strategy:      "mask-classified",
		},
	}
}

func dataFilterContract() NodeType {
	return NodeType{
		Type:        "data.filter",
		Phase:       PhaseCore,
		Title:       "Filter items",
		Description: "Splits items into kept and dropped by a declarative comparison (path/op/compare) or an FFX boolean expression evaluated per item. Order is preserved. Both ports fire.",
		Inputs:      []Port{inheritPort("input", PortItems, true, "Items as {items: [...]}; an object reads as one item.")},
		Outputs: []Port{
			inheritPort("kept", PortItems, false, "{items: [...]} that matched, in input order."),
			inheritPort("dropped", PortItems, false, "{items: [...]} that did not match, in input order."),
		},
		AllowedWith: []WithField{
			{Name: "path", Kind: "string", Description: "Dotted identifier path into each item. No expressions."},
			{Name: "op", Kind: "enum", Enum: conditionOps, Description: "Declarative comparison operator. Required unless expr is set."},
			{Name: "compare", Kind: "any", Description: "Literal compare value. Required except when op is exists."},
			{Name: "expr", Kind: WithKindExpr, ExprType: string(PortBoolean), Description: "FFX boolean expression, as {expr: \"...\"}; item is the current item. Not combined with path, op or compare."},
		},
		Policy:    defaultNeutralPolicy(),
		Bounds:    defaultNeutralBounds(),
		Redaction: itemsPolicy(),
	}
}

func dataSortContract() NodeType {
	return NodeType{
		Type:         "data.sort",
		Phase:        PhaseCore,
		Title:        "Sort items",
		Description:  "Stable sort of items by one key. Every item must have the key and every key must have the same type; otherwise the step fails.",
		Inputs:       []Port{inheritPort("input", PortItems, true, "Items as {items: [...]}; an object reads as one item.")},
		Outputs:      []Port{inheritPort("result", PortItems, false, "{items: [...]} in sorted order. Equal keys keep input order.")},
		RequiredWith: []string{"key"},
		AllowedWith: []WithField{
			{Name: "key", Kind: "string", Required: true, Description: "Dotted identifier path to the sort key on each item."},
			{Name: "type", Kind: "enum", Enum: sortTypes, Description: "string, number or timestamp (RFC 3339). Default: the type of the first key, string or number."},
			{Name: "order", Kind: "enum", Enum: sortOrders, Description: "asc (default) or desc."},
		},
		Policy:    defaultNeutralPolicy(),
		Bounds:    defaultNeutralBounds(),
		Redaction: itemsPolicy(),
	}
}

func dataMergeContract() NodeType {
	return NodeType{
		Type:        "data.merge",
		Phase:       PhaseCore,
		Title:       "Merge items",
		Description: "Combines left and right items. append: left then right. zip: pairwise, lists must be the same length. byKey: left order, each left item merged with the right item of the same key, then unmatched right items in order. On a field conflict the right value wins.",
		Inputs: []Port{
			inheritPort("left", PortItems, true, "Left items as {items: [...]}; an object reads as one item."),
			inheritPort("right", PortItems, true, "Right items as {items: [...]}; an object reads as one item."),
		},
		Outputs:      []Port{inheritPort("result", PortItems, false, "{items: [...]} merged.")},
		RequiredWith: []string{"mode"},
		AllowedWith: []WithField{
			{Name: "mode", Kind: "enum", Required: true, Enum: mergeModes, Description: "append, zip or byKey."},
			{Name: "key", Kind: "string", Description: "Dotted identifier path to the join key. Required for byKey only. Key values must be strings or numbers and unique per side."},
		},
		Policy:    defaultNeutralPolicy(),
		Bounds:    defaultNeutralBounds(),
		Redaction: itemsPolicy(),
	}
}

// switchPortNames returns the output ports a flow.switch declares in its
// with: each case name in order, then default. Malformed entries are
// skipped; validation reports them.
func switchPortNames(with map[string]any) []string {
	var out []string
	cases, _ := with["cases"].([]any)
	for _, c := range cases {
		m, _ := c.(map[string]any)
		if name, ok := m["name"].(string); ok && name != "" {
			out = append(out, name)
		}
	}
	if d, ok := with["default"].(string); ok && d != "" {
		out = append(out, d)
	}
	return out
}

// nodeOutputPort resolves an output port on one node. flow.switch ports
// come from that node's cases and default.
func nodeOutputPort(n Node, nt NodeType, name string) (Port, bool) {
	if p, ok := nt.outputPort(name); ok {
		return p, true
	}
	if n.Type == "flow.switch" && validSwitchPortName(name) {
		for _, s := range switchPortNames(n.With) {
			if s == name {
				return inheritPort(name, PortAny, false, "Inbound value when this case is selected."), true
			}
		}
	}
	return Port{}, false
}

func validSwitchPortName(s string) bool {
	return len(s) <= switchCaseNameMaxLen && switchCaseNameRE.MatchString(s) &&
		!reservedSwitchPorts[s] && !strings.HasPrefix(s, ReservedOutputPrefix)
}

// ---- publish-time with checks ----

func validateSwitchWith(n Node, path string) ErrorList {
	var errs ErrorList
	at := func(p, code, msg string) {
		errs = append(errs, fieldError(path+p, n.pos.Line, n.pos.Column, code, msg))
	}
	if raw, ok := n.With["path"]; ok {
		s, ok := raw.(string)
		if !ok || !validFieldPath(s) {
			at(".with.path", CodeInvalidWith, "path must be a dotted identifier path.")
		} else if looksLikeExpression(s) {
			at(".with.path", CodeExpressionForbidden, "Switch paths cannot contain expressions.")
		}
	}
	seen := map[string]bool{}
	if raw, ok := n.With["cases"]; ok {
		cases, ok := raw.([]any)
		switch {
		case !ok:
			at(".with.cases", CodeInvalidType, "cases must be a list.")
		case len(cases) == 0:
			at(".with.cases", CodeInvalidWith, "cases must declare at least one case.")
		case len(cases) > MaxSwitchCases:
			at(".with.cases", CodeAggregationLimit, fmt.Sprintf("cases exceeds the limit of %d.", MaxSwitchCases))
		}
		for i, c := range cases {
			cp := fmt.Sprintf(".with.cases[%d]", i)
			m, ok := c.(map[string]any)
			if !ok {
				at(cp, CodeInvalidType, "Each case must be an object.")
				continue
			}
			for k := range m {
				if k != "name" && k != "op" && k != "compare" {
					// Fixed message, index-only path: never echo a client-chosen key.
					at(cp, CodeUnknownField, "Case has an unknown field; allowed fields are name, op and compare.")
				}
			}
			name, _ := m["name"].(string)
			if !validSwitchPortName(name) {
				at(cp+".name", CodeInvalidWith, "Case name must be a port name: a letter, then letters, digits, _ or -, at most 64 characters, and not port, error or __ff_*.")
			} else if seen[name] {
				at(cp+".name", CodeDuplicateID, "Case names must be unique.")
			}
			seen[name] = true
			op, _ := m["op"].(string)
			if !oneOf(op, conditionOps...) {
				at(cp+".op", CodeInvalidWith, "op must be a declarative comparison operator.")
			}
			cmp, hasCmp := m["compare"]
			if op == "exists" && hasCmp {
				at(cp+".compare", CodeUnknownField, "exists does not accept compare.")
			}
			if op != "" && op != "exists" && !hasCmp {
				at(cp+".compare", CodeMissingField, "Case requires compare unless op is exists.")
			}
			if hasCmp {
				if s, ok := cmp.(string); ok && looksLikeExpression(s) {
					at(cp+".compare", CodeExpressionForbidden, "compare must be a literal, not an expression.")
				}
				if _, ce := classifyLiteral(cmp); len(ce) > 0 {
					errs = append(errs, relocateErrors(ce, path+cp+".compare")...)
				}
			}
		}
	}
	if raw, ok := n.With["default"]; ok {
		d, ok := raw.(string)
		if !ok || !validSwitchPortName(d) {
			at(".with.default", CodeInvalidWith, "default must be a port name.")
		} else if seen[d] {
			at(".with.default", CodeDuplicateID, "default must differ from every case name.")
		}
	}
	return errs
}

func validateItemComparison(n Node, path, noun string) ErrorList {
	var errs ErrorList
	at := func(p, code, msg string) {
		errs = append(errs, fieldError(path+p, n.pos.Line, n.pos.Column, code, msg))
	}
	op, hasOp := n.With["op"].(string)
	if _, ok := n.With["op"]; !ok {
		at(".with.op", CodeMissingField, noun+" requires with.op or with.expr.")
	} else if !hasOp || !oneOf(op, conditionOps...) {
		at(".with.op", CodeInvalidWith, "op must be a declarative comparison operator.")
	}
	cmp, hasCmp := n.With["compare"]
	if op == "exists" && hasCmp {
		at(".with.compare", CodeUnknownField, "exists does not accept compare.")
	}
	if op != "" && op != "exists" && !hasCmp {
		at(".with.compare", CodeMissingField, noun+" requires with.compare unless op is exists.")
	}
	if hasCmp {
		if s, ok := cmp.(string); ok && looksLikeExpression(s) {
			at(".with.compare", CodeExpressionForbidden, "compare must be a literal, not an expression.")
		}
		if _, ce := classifyLiteral(cmp); len(ce) > 0 {
			errs = append(errs, relocateErrors(ce, path+".with.compare")...)
		}
	}
	errs = append(errs, validateOptionalPath(n, path, "path")...)
	return errs
}

func validateOptionalPath(n Node, path, field string) ErrorList {
	raw, ok := n.With[field]
	if !ok {
		return nil
	}
	s, ok := raw.(string)
	if !ok || !validFieldPath(s) {
		return ErrorList{fieldError(path+".with."+field, n.pos.Line, n.pos.Column, CodeInvalidWith, field+" must be a dotted identifier path.")}
	}
	if looksLikeExpression(s) {
		return ErrorList{fieldError(path+".with."+field, n.pos.Line, n.pos.Column, CodeExpressionForbidden, field+" cannot contain expressions.")}
	}
	return nil
}

func validateFilterWith(n Node, path string) ErrorList {
	if _, ok := n.With["expr"]; ok {
		return validateExprOnly(n, path, "expr", "op", "compare", "path")
	}
	return validateItemComparison(n, path, "data.filter")
}

func validateEnumField(n Node, path, field string, allowed []string) ErrorList {
	raw, ok := n.With[field]
	if !ok {
		return nil
	}
	if s, ok := raw.(string); !ok || !oneOf(s, allowed...) {
		return ErrorList{fieldError(path+".with."+field, n.pos.Line, n.pos.Column, CodeInvalidWith, fmt.Sprintf("%s must be one of %s.", field, strings.Join(allowed, ", ")))}
	}
	return nil
}

func validateSortWith(n Node, path string) ErrorList {
	errs := validateOptionalPath(n, path, "key")
	errs = append(errs, validateEnumField(n, path, "type", sortTypes)...)
	errs = append(errs, validateEnumField(n, path, "order", sortOrders)...)
	return errs
}

func validateMergeWith(n Node, path string) ErrorList {
	errs := validateEnumField(n, path, "mode", mergeModes)
	errs = append(errs, validateOptionalPath(n, path, "key")...)
	mode, _ := n.With["mode"].(string)
	_, hasKey := n.With["key"]
	if mode == mergeModeByKey && !hasKey {
		errs = append(errs, fieldError(path+".with.key", n.pos.Line, n.pos.Column, CodeMissingField, "byKey requires with.key."))
	}
	if mode != "" && mode != mergeModeByKey && hasKey {
		errs = append(errs, fieldError(path+".with.key", n.pos.Line, n.pos.Column, CodeUnknownField, "with.key applies only to mode byKey."))
	}
	return errs
}

// ---- runtime ----

// carriedItems reads a port value as a list of objects. It enforces the
// port byte cap and MaxItemsPerPort, and never echoes values.
func carriedItems(raw any, port string) ([]map[string]any, ErrorList) {
	p := "inputs." + port
	if encodedBytes(raw) > MaxPortBytes {
		return nil, ErrorList{fieldError(p, 0, 0, CodeOutputTooLarge, fmt.Sprintf("%s exceeds the %d byte limit.", port, MaxPortBytes))}
	}
	var list []any
	switch t := raw.(type) {
	case []any:
		list = t
	case map[string]any:
		if inner, ok := t[ItemsField]; ok && len(t) == 1 {
			l, ok := inner.([]any)
			if !ok {
				return nil, ErrorList{fieldError(p, 0, 0, CodeInvalidType, port+".items must be a list.")}
			}
			list = l
		} else {
			list = []any{t}
		}
	default:
		return nil, ErrorList{fieldError(p, 0, 0, CodeInvalidType, port+" must be {items: [...]}, an object, or a list of objects.")}
	}
	if len(list) > MaxItemsPerPort {
		return nil, ErrorList{fieldError(p, 0, 0, CodeAggregationLimit, fmt.Sprintf("%s exceeds %d items.", port, MaxItemsPerPort))}
	}
	out := make([]map[string]any, len(list))
	for i, it := range list {
		m, ok := it.(map[string]any)
		if !ok {
			return nil, ErrorList{fieldError(fmt.Sprintf("%s.items[%d]", p, i), 0, 0, CodeInvalidType, "Each item must be an object.")}
		}
		out[i] = m
	}
	return out, nil
}

func itemsValue(items []map[string]any) map[string]any {
	l := make([]any, len(items))
	for i, it := range items {
		l[i] = it
	}
	return map[string]any{ItemsField: l}
}

func checkPortSize(port string, v any) ErrorList {
	if encodedBytes(v) > MaxPortBytes {
		return ErrorList{fieldError(port, 0, 0, CodeOutputTooLarge, fmt.Sprintf("%s exceeds the %d byte limit.", port, MaxPortBytes))}
	}
	return nil
}

func evalSwitch(with, inputs map[string]any) (*EvalResult, ErrorList) {
	value, ok := inputs["value"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeRequiredInput, "flow.switch requires input value.")}
	}
	if encodedBytes(value) > MaxPortBytes {
		return nil, ErrorList{fieldError("inputs.value", 0, 0, CodeOutputTooLarge, fmt.Sprintf("value exceeds the %d byte limit.", MaxPortBytes))}
	}
	cases, ok := with["cases"].([]any)
	if !ok || len(cases) == 0 || len(cases) > MaxSwitchCases {
		return nil, ErrorList{fieldError("with.cases", 0, 0, CodeInvalidWith, fmt.Sprintf("flow.switch requires 1 to %d cases.", MaxSwitchCases))}
	}
	subject, found := value, true
	if raw, ok := with["path"].(string); ok && raw != "" {
		if !validFieldPath(raw) {
			return nil, ErrorList{fieldError("with.path", 0, 0, CodeInvalidWith, "path must be a dotted identifier path.")}
		}
		subject, found = lookupPath(value, raw)
	}
	chosen, idx := "", -1
	for i, c := range cases {
		m, _ := c.(map[string]any)
		name, _ := m["name"].(string)
		op, _ := m["op"].(string)
		if !validSwitchPortName(name) || !oneOf(op, conditionOps...) {
			return nil, ErrorList{fieldError(fmt.Sprintf("with.cases[%d]", i), 0, 0, CodeInvalidWith, "Case needs a port name and a declarative operator.")}
		}
		if !found {
			continue // a missing path matches no case, not even exists
		}
		matched, errs := compareDeclarative(op, subject, m["compare"])
		if len(errs) > 0 {
			return nil, relocateErrors(errs, fmt.Sprintf("with.cases[%d]", i))
		}
		if matched {
			chosen, idx = name, i
			break
		}
	}
	if chosen == "" {
		d, _ := with["default"].(string)
		if !validSwitchPortName(d) {
			// Publish requires default; a stored version without one
			// still fails closed instead of routing nowhere.
			return nil, ErrorList{fieldError("with.default", 0, 0, CodeSwitchNoMatch, "No case matched and flow.switch has no default port.")}
		}
		chosen = d
	}
	class := inputClass(value)
	return &EvalResult{
		Outputs:        map[string]any{chosen: value, "port": chosen},
		Classification: class,
		Audit:          map[string]any{"port": chosen, "caseIndex": idx, "classification": class},
	}, nil
}

func evalFilter(with, inputs map[string]any, rc *RunContext) (*EvalResult, ErrorList) {
	raw, ok := inputs["input"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeRequiredInput, "data.filter requires input input.")}
	}
	items, errs := carriedItems(raw, "input")
	if len(errs) > 0 {
		return nil, errs
	}
	_, useExpr := with["expr"]
	op, _ := with["op"].(string)
	path, _ := with["path"].(string)
	if !useExpr {
		if !oneOf(op, conditionOps...) {
			return nil, ErrorList{fieldError("with.op", 0, 0, CodeInvalidWith, "op must be a declarative comparison operator.")}
		}
		if path != "" && !validFieldPath(path) {
			return nil, ErrorList{fieldError("with.path", 0, 0, CodeInvalidWith, "path must be a dotted identifier path.")}
		}
	}
	// The expression is checked and built once per step, then evaluated
	// per item.
	var fe *fieldExpr
	if useExpr {
		var errs ErrorList
		if fe, errs = prepareFieldExpr("data.filter", "expr", with, inputs, rc); len(errs) > 0 {
			return nil, errs
		}
	}
	kept := make([]map[string]any, 0, len(items))
	dropped := make([]map[string]any, 0)
	for i, it := range items {
		var match bool
		if useExpr {
			got, errs := fe.eval(it)
			if len(errs) > 0 {
				return nil, errs
			}
			b, ok := got.(bool)
			if !ok {
				return nil, exprFieldError(rc, "expr", CodeExpressionType, "Expression result at runtime is not a boolean.")
			}
			match = b
		} else {
			subject, found := lookupPath(any(it), path)
			if op == "exists" {
				match = found && subject != nil
			} else if found {
				m, errs := compareDeclarative(op, subject, with["compare"])
				if len(errs) > 0 {
					for j := range errs {
						errs[j].Path = fmt.Sprintf("inputs.input.items[%d]", i)
					}
					return nil, errs
				}
				match = m
			}
		}
		if match {
			kept = append(kept, it)
		} else {
			dropped = append(dropped, it)
		}
	}
	kv, dv := itemsValue(kept), itemsValue(dropped)
	if errs := checkPortSize("kept", kv); len(errs) > 0 {
		return nil, errs
	}
	if errs := checkPortSize("dropped", dv); len(errs) > 0 {
		return nil, errs
	}
	class := inputClass(raw)
	return &EvalResult{
		Outputs:        map[string]any{"kept": kv, "dropped": dv},
		Classification: class,
		Audit:          map[string]any{"inCount": len(items), "outCount": len(kept), "classification": class},
	}, nil
}

type sortKey struct {
	s string
	n *big.Rat
	t time.Time
}

func evalSort(with, inputs map[string]any) (*EvalResult, ErrorList) {
	raw, ok := inputs["input"]
	if !ok {
		return nil, ErrorList{fieldError("inputs.input", 0, 0, CodeRequiredInput, "data.sort requires input input.")}
	}
	items, errs := carriedItems(raw, "input")
	if len(errs) > 0 {
		return nil, errs
	}
	key, _ := with["key"].(string)
	if !validFieldPath(key) {
		return nil, ErrorList{fieldError("with.key", 0, 0, CodeInvalidWith, "key must be a dotted identifier path.")}
	}
	typ, _ := with["type"].(string)
	if typ != "" && !oneOf(typ, sortTypes...) {
		return nil, ErrorList{fieldError("with.type", 0, 0, CodeInvalidWith, "type must be string, number or timestamp.")}
	}
	order, _ := with["order"].(string)
	if order == "" {
		order = "asc"
	}
	if !oneOf(order, sortOrders...) {
		return nil, ErrorList{fieldError("with.order", 0, 0, CodeInvalidWith, "order must be asc or desc.")}
	}
	keys := make([]sortKey, len(items))
	for i, it := range items {
		at := fmt.Sprintf("inputs.input.items[%d]", i)
		v, found := lookupPath(any(it), key)
		if !found || v == nil {
			return nil, ErrorList{fieldError(at, 0, 0, CodeSortKeyMissing, "An item has no value at the sort key.")}
		}
		kind := ""
		switch {
		case jsonnum.IsNumber(v):
			kind = sortTypeNumber
		default:
			if _, ok := v.(string); ok {
				kind = sortTypeString
			}
		}
		if typ == "" {
			if kind == "" {
				return nil, ErrorList{fieldError(at, 0, 0, CodeSortMixedTypes, "Sort keys must be strings, numbers or timestamps.")}
			}
			typ = kind
		}
		want := typ
		if want == sortTypeTimestamp {
			want = sortTypeString
		}
		if kind != want {
			return nil, ErrorList{fieldError(at, 0, 0, CodeSortMixedTypes, fmt.Sprintf("Sort keys have mixed types; every key must be a %s.", typ))}
		}
		switch typ {
		case sortTypeNumber:
			r, err := jsonnum.Rat(v)
			if err != nil {
				msg := "Sort key is not a finite number."
				if errors.Is(err, jsonnum.ErrTooLarge) {
					msg = "Value is too large to compare exactly."
				}
				return nil, ErrorList{fieldError(at, 0, 0, CodeInvalidType, msg)}
			}
			keys[i].n = r
		case sortTypeTimestamp:
			t, err := time.Parse(time.RFC3339Nano, v.(string))
			if err != nil {
				return nil, ErrorList{fieldError(at, 0, 0, CodeSortMixedTypes, "Sort key is not an RFC 3339 timestamp.")}
			}
			keys[i].t = t
		default:
			keys[i].s = v.(string)
		}
	}
	idx := make([]int, len(items))
	for i := range idx {
		idx[i] = i
	}
	cmp := func(a, b sortKey) int {
		switch typ {
		case sortTypeNumber:
			return a.n.Cmp(b.n)
		case sortTypeTimestamp:
			return a.t.Compare(b.t)
		default:
			return strings.Compare(a.s, b.s)
		}
	}
	// Stable in both directions: desc flips the comparison, not the
	// result, so equal keys keep input order.
	sort.SliceStable(idx, func(i, j int) bool {
		c := cmp(keys[idx[i]], keys[idx[j]])
		if order == "desc" {
			return c > 0
		}
		return c < 0
	})
	sorted := make([]map[string]any, len(items))
	for i, k := range idx {
		sorted[i] = items[k]
	}
	out := itemsValue(sorted)
	if errs := checkPortSize("result", out); len(errs) > 0 {
		return nil, errs
	}
	class := inputClass(raw)
	return &EvalResult{
		Outputs:        map[string]any{"result": out},
		Classification: class,
		Audit:          map[string]any{"inCount": len(items), "outCount": len(sorted), "classification": class},
	}, nil
}

// mergeKey is an exact, type-tagged identity for a byKey join value. A
// number is keyed by its exact rational, so 1, 1.0 and an exact
// json.Number 1 join; a number never joins a string.
func mergeKey(v any) (string, bool) {
	if s, ok := v.(string); ok {
		return "s:" + s, true
	}
	if r, err := jsonnum.Rat(v); err == nil {
		return "n:" + r.RatString(), true
	}
	return "", false
}

func shallowMerge(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func keyIndex(items []map[string]any, key, port string) (map[string]int, []string, ErrorList) {
	idx := make(map[string]int, len(items))
	ks := make([]string, len(items))
	for i, it := range items {
		at := fmt.Sprintf("inputs.%s.items[%d]", port, i)
		v, found := lookupPath(any(it), key)
		if !found {
			return nil, nil, ErrorList{fieldError(at, 0, 0, CodeMergeKeyMissing, "An item has no value at the merge key.")}
		}
		k, ok := mergeKey(v)
		if !ok {
			return nil, nil, ErrorList{fieldError(at, 0, 0, CodeInvalidType, "Merge key must be a string or a number.")}
		}
		if _, dup := idx[k]; dup {
			return nil, nil, ErrorList{fieldError(at, 0, 0, CodeMergeDuplicateKey, "Merge keys must be unique on each side.")}
		}
		idx[k] = i
		ks[i] = k
	}
	return idx, ks, nil
}

func evalMerge(with, inputs map[string]any) (*EvalResult, ErrorList) {
	lraw, lok := inputs["left"]
	rraw, rok := inputs["right"]
	if !lok {
		return nil, ErrorList{fieldError("inputs.left", 0, 0, CodeRequiredInput, "data.merge requires input left.")}
	}
	if !rok {
		return nil, ErrorList{fieldError("inputs.right", 0, 0, CodeRequiredInput, "data.merge requires input right.")}
	}
	left, errs := carriedItems(lraw, "left")
	if len(errs) > 0 {
		return nil, errs
	}
	right, errs := carriedItems(rraw, "right")
	if len(errs) > 0 {
		return nil, errs
	}
	mode, _ := with["mode"].(string)
	var merged []map[string]any
	switch mode {
	case mergeModeAppend:
		merged = append(append(make([]map[string]any, 0, len(left)+len(right)), left...), right...)
	case mergeModeZip:
		if len(left) != len(right) {
			return nil, ErrorList{fieldError("inputs", 0, 0, CodeMergeLengthMismatch, "zip requires left and right to have the same number of items.")}
		}
		merged = make([]map[string]any, len(left))
		for i := range left {
			merged[i] = shallowMerge(left[i], right[i])
		}
	case mergeModeByKey:
		key, _ := with["key"].(string)
		if !validFieldPath(key) {
			return nil, ErrorList{fieldError("with.key", 0, 0, CodeInvalidWith, "byKey requires a dotted identifier key path.")}
		}
		_, lkeys, errs := keyIndex(left, key, "left")
		if len(errs) > 0 {
			return nil, errs
		}
		ridx, rkeys, errs := keyIndex(right, key, "right")
		if len(errs) > 0 {
			return nil, errs
		}
		used := make([]bool, len(right))
		merged = make([]map[string]any, 0, len(left)+len(right))
		for i, it := range left {
			if j, ok := ridx[lkeys[i]]; ok {
				used[j] = true
				merged = append(merged, shallowMerge(it, right[j]))
			} else {
				merged = append(merged, it)
			}
		}
		for j, it := range right {
			if !used[j] {
				merged = append(merged, it)
			}
		}
		_ = rkeys
	default:
		return nil, ErrorList{fieldError("with.mode", 0, 0, CodeInvalidWith, "mode must be append, zip or byKey.")}
	}
	if len(merged) > MaxItemsPerPort {
		return nil, ErrorList{fieldError("result", 0, 0, CodeAggregationLimit, fmt.Sprintf("Merged result exceeds %d items.", MaxItemsPerPort))}
	}
	out := itemsValue(merged)
	if errs := checkPortSize("result", out); len(errs) > 0 {
		return nil, errs
	}
	class := maxClassification(inputClass(lraw), inputClass(rraw))
	return &EvalResult{
		Outputs:        map[string]any{"result": out},
		Classification: class,
		Audit:          map[string]any{"inCount": len(left) + len(right), "outCount": len(merged), "classification": class},
	}, nil
}
