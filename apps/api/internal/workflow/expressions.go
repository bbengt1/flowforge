package workflow

import (
	"fmt"
	"sort"

	"github.com/bbengt1/flowforge/apps/api/internal/expr"
)

// CatalogRevision is the node-semantics revision inside flowforge/v1
// (#650 §7). Revision 1 is the first catalog whose publish records FFX
// expression semantics (E3.2). Versions published before it keep a NULL
// catalog_revision and their old semantics, pinned by digest. Revision 2
// (E3.3) adds the expr fields on data.map and flow.condition. Revision 3
// (E3.4) enables flow.switch, data.filter (with its expr field), data.sort
// and data.merge.
const CatalogRevision = 3

// ExpressionRef is one checked expression as recorded on a published
// version: the field, its static type and what it references. It never
// holds expression source (that is in the YAML, under the digest) or values.
type ExpressionRef struct {
	NodeID   string     `json:"nodeId"`
	Field    string     `json:"field"`
	Type     string     `json:"type"`
	Inputs   []InputRef `json:"inputs,omitempty"`
	Vars     []string   `json:"vars,omitempty"`
	Run      []string   `json:"run,omitempty"`
	Workflow []string   `json:"workflow,omitempty"`
	Item     bool       `json:"item,omitempty"`
	Items    bool       `json:"items,omitempty"`
	Trigger  bool       `json:"trigger,omitempty"`
}

// InputRef is an input port an expression reads and the upstream step
// port that feeds it ("" From means a literal node input).
type InputRef struct {
	Port string `json:"port"`
	From string `json:"from,omitempty"`
}

// ExpressionType is the type-check-route projection: types and paths only.
type ExpressionType struct {
	NodeID string `json:"nodeId"`
	Field  string `json:"field"`
	Path   string `json:"path"`
	Type   string `json:"type"`
}

// ExpressionReport is the result of CheckExpressions.
type ExpressionReport struct {
	Refs []ExpressionRef
}

// Types projects the report for the type-check route.
func (r ExpressionReport) Types() []ExpressionType {
	out := make([]ExpressionType, 0, len(r.Refs))
	for _, ref := range r.Refs {
		out = append(out, ExpressionType{NodeID: ref.NodeID, Field: ref.Field, Path: exprPath(ref.NodeID, ref.Field), Type: ref.Type})
	}
	return out
}

func exprPath(nodeID, field string) string {
	return fmt.Sprintf("spec.nodes[%s].with.%s.expr", nodeID, field)
}

// ExpressionFields returns the declared expr with-fields of a node type.
func ExpressionFields(nodeType string) []WithField {
	nt, ok := lookupNode(nodeType)
	if !ok {
		return nil
	}
	var out []WithField
	for _, f := range nt.AllowedWith {
		if f.Kind == WithKindExpr {
			out = append(out, f)
		}
	}
	return out
}

// ExpressionSource returns the source of an {expr: "..."} value.
func ExpressionSource(v any) (string, bool) {
	m, ok := v.(map[string]any)
	if !ok || len(m) != 1 {
		return "", false
	}
	s, ok := m["expr"].(string)
	return s, ok
}

// CheckExpressions is the publish-time FFX check (#650 E3.2): parse, static
// ref extraction, type check against port kinds and the static cost
// estimate, for every catalog-declared expr field. It never evaluates.
// References resolve only inside doc. Errors name the node id and carry no
// line or column. doc must already have passed validation.
func CheckExpressions(doc *Document) (ExpressionReport, ErrorList) {
	var report ExpressionReport
	var errs ErrorList
	if doc == nil {
		return report, ErrorList{{Path: "spec", Code: CodeExpressionParse, Message: "No document to check."}}
	}
	nodesByID := map[string]Node{}
	for _, n := range doc.Spec.Nodes {
		nodesByID[n.ID] = n
	}
	for _, n := range doc.Spec.Nodes {
		fields := ExpressionFields(n.Type)
		if len(fields) == 0 {
			continue
		}
		nt, _ := lookupNode(n.Type)
		declared := map[string]expr.Kind{}
		for _, p := range nt.Inputs {
			declared[p.Name] = expr.Kind(p.Kind)
		}
		wired := map[string]expr.Kind{}
		from := map[string]string{}
		for p := range n.Inputs {
			if k, ok := declared[p]; ok {
				wired[p] = k
			}
		}
		for _, e := range doc.Spec.Edges {
			to, ok1 := parsePortRef(e.To)
			src, ok2 := parsePortRef(e.From)
			if !ok1 || !ok2 || to.NodeID != n.ID {
				continue
			}
			if _, ok := declared[to.Port]; !ok {
				continue
			}
			kind := declared[to.Port]
			if ut, ok := lookupNode(nodesByID[src.NodeID].Type); ok {
				if op, ok := nodeOutputPort(nodesByID[src.NodeID], ut, src.Port); ok {
					kind = expr.Kind(op.Kind)
				} else if src.Port == ErrorPortName {
					kind = expr.KindObject
				}
			}
			wired[to.Port] = kind
			from[to.Port] = e.From
		}
		mode := expr.ModePerItem
		if m, ok := n.With["mode"].(string); ok && m == expr.ModeOnce {
			mode = expr.ModeOnce
		}
		for _, f := range fields {
			raw, present := n.With[f.Name]
			if !present {
				continue
			}
			fe := FieldError{Path: exprPath(n.ID, f.Name), NodeID: n.ID}
			src, ok := ExpressionSource(raw)
			if !ok {
				fe.Code, fe.Message = CodeExpressionParse, fmt.Sprintf("Node %q with.%s must be {expr: <string>}.", n.ID, f.Name)
				errs = append(errs, fe)
				continue
			}
			want := expr.Kind(f.ExprType)
			if want == "" {
				want = expr.KindAny
			}
			res, cerr := expr.Check(src, expr.Scope{
				Mode: mode, Declared: declared, Wired: wired, Want: want, SecretRefOK: f.AcceptsSecretRef, CoreNode: n.Type != TestExprNodeType, // test.ffx keeps the full E3.2 scope
			})
			if cerr != nil {
				fe.Code, fe.Message = cerr.Code, fmt.Sprintf("Node %q with.%s: %s", n.ID, f.Name, cerr.Message)
				errs = append(errs, fe)
				continue
			}
			ref := ExpressionRef{
				NodeID: n.ID, Field: f.Name, Type: res.Type,
				Vars: res.Refs.Vars, Run: res.Refs.Run, Workflow: res.Refs.Workflow,
				Item: res.Refs.Item, Items: res.Refs.Items, Trigger: res.Refs.Trigger,
			}
			for _, p := range res.Refs.Inputs {
				ref.Inputs = append(ref.Inputs, InputRef{Port: p, From: from[p]})
			}
			report.Refs = append(report.Refs, ref)
		}
	}
	sort.SliceStable(report.Refs, func(i, j int) bool {
		if report.Refs[i].NodeID != report.Refs[j].NodeID {
			return report.Refs[i].NodeID < report.Refs[j].NodeID
		}
		return report.Refs[i].Field < report.Refs[j].Field
	})
	return report, errs
}
