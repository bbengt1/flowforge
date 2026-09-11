package workflow

import (
	"fmt"
	"math"
	"sort"

	"gopkg.in/yaml.v3"
)

var uiKeys = map[string]bool{
	"layout": true,
}

var layoutKeys = map[string]bool{
	"version": true,
	"nodes":   true,
}

var layoutPositionKeys = map[string]bool{
	"x": true,
	"y": true,
}

func decodeUI(n *yaml.Node) (*UIMetadata, ErrorList) {
	if n == nil || n.Tag == "!!null" {
		return nil, nil
	}
	if n.Kind != yaml.MappingNode {
		return nil, ErrorList{fieldError("metadata.ui", n.Line, n.Column, CodeInvalidType, "metadata.ui must be a mapping.")}
	}
	var errs ErrorList
	for _, k := range mappingKeys(n) {
		if !uiKeys[k.key] {
			errs = append(errs, fieldError("metadata.ui."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q.", k.key)))
		}
	}
	ui := &UIMetadata{}
	if v, ok := mappingValue(n, "layout"); ok {
		layout, layoutErrs := decodeLayout(v)
		errs = append(errs, layoutErrs...)
		ui.Layout = layout
	}
	if len(errs) > 0 {
		return ui, errs
	}
	if ui.Layout == nil {
		return nil, nil
	}
	return ui, nil
}

func decodeLayout(n *yaml.Node) (*UILayout, ErrorList) {
	if n == nil || n.Tag == "!!null" {
		return nil, nil
	}
	// Non-object layout is treated as absent (auto-layout). Do not invent a graph.
	if n.Kind != yaml.MappingNode {
		return nil, nil
	}
	var errs ErrorList
	for _, k := range mappingKeys(n) {
		if !layoutKeys[k.key] {
			errs = append(errs, fieldError("metadata.ui.layout."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q. Layout never carries edges, types, with, credentials, or ports.", k.key)))
		}
	}
	layout := &UILayout{Version: UILayoutVersion, Nodes: map[string]UINodePosition{}}
	if v, ok := mappingValue(n, "version"); ok {
		ver, ok := finiteInt(decodeScalar(v))
		if !ok || ver != UILayoutVersion {
			// Unsupported / non-finite version → treat layout as absent.
			if len(errs) > 0 {
				return nil, errs
			}
			return nil, nil
		}
		layout.Version = ver
	}
	if v, ok := mappingValue(n, "nodes"); ok {
		if v.Tag == "!!null" {
			// empty
		} else if v.Kind != yaml.MappingNode {
			if len(errs) > 0 {
				return nil, errs
			}
			return nil, nil
		} else {
			nodes, nodeErrs := decodeLayoutNodes(v)
			errs = append(errs, nodeErrs...)
			layout.Nodes = nodes
		}
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return layout, nil
}

func decodeLayoutNodes(n *yaml.Node) (map[string]UINodePosition, ErrorList) {
	out := map[string]UINodePosition{}
	var errs ErrorList
	for _, k := range mappingKeys(n) {
		path := "metadata.ui.layout.nodes." + k.key
		pos, keep, posErrs := decodeLayoutPosition(k.node, path)
		errs = append(errs, posErrs...)
		if keep {
			out[k.key] = pos
		}
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return out, nil
}

func decodeLayoutPosition(n *yaml.Node, path string) (UINodePosition, bool, ErrorList) {
	if n == nil || n.Tag == "!!null" || n.Kind != yaml.MappingNode {
		// Non-object position → drop that node (auto-place it). Never invent a node.
		return UINodePosition{}, false, nil
	}
	var errs ErrorList
	for _, k := range mappingKeys(n) {
		if !layoutPositionKeys[k.key] {
			errs = append(errs, fieldError(path+"."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q. Layout positions may declare only x and y.", k.key)))
		}
	}
	xNode, hasX := mappingValue(n, "x")
	yNode, hasY := mappingValue(n, "y")
	if !hasX || !hasY {
		if len(errs) > 0 {
			return UINodePosition{}, false, errs
		}
		return UINodePosition{}, false, nil
	}
	x, xOK := finiteNumber(decodeScalar(xNode))
	y, yOK := finiteNumber(decodeScalar(yNode))
	if !xOK || !yOK {
		if len(errs) > 0 {
			return UINodePosition{}, false, errs
		}
		return UINodePosition{}, false, nil
	}
	if len(errs) > 0 {
		return UINodePosition{}, false, errs
	}
	return UINodePosition{X: x, Y: y}, true, nil
}

// bindLayoutToSpec drops layout keys that are not spec.nodes[].id.
// Extra keys are stripped (never invent a node). Missing keys stay auto-placed.
func bindLayoutToSpec(doc *Document) {
	if doc == nil || doc.Metadata.UI == nil || doc.Metadata.UI.Layout == nil {
		return
	}
	layout := doc.Metadata.UI.Layout
	if layout.Version != UILayoutVersion {
		doc.Metadata.UI = nil
		return
	}
	known := map[string]bool{}
	for _, n := range doc.Spec.Nodes {
		if n.ID != "" {
			known[n.ID] = true
		}
	}
	cleaned := map[string]UINodePosition{}
	for id, pos := range layout.Nodes {
		if !known[id] {
			continue
		}
		if !isFinite(pos.X) || !isFinite(pos.Y) {
			continue
		}
		cleaned[id] = pos
	}
	layout.Nodes = cleaned
	layout.Version = UILayoutVersion
}

func encodeUI(ui *UIMetadata) *yaml.Node {
	if ui == nil || ui.Layout == nil {
		return nil
	}
	layout := encodeLayout(ui.Layout)
	if layout == nil {
		return nil
	}
	n := mappingNode()
	appendKV(n, "layout", layout)
	return n
}

func encodeLayout(layout *UILayout) *yaml.Node {
	if layout == nil {
		return nil
	}
	n := mappingNode()
	appendKV(n, "version", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprintf("%d", UILayoutVersion)})
	if len(layout.Nodes) > 0 {
		nodes := mappingNode()
		for _, id := range sortedLayoutNodeIDs(layout.Nodes) {
			pos := layout.Nodes[id]
			item := mappingNode()
			item.Style = yaml.FlowStyle
			appendKV(item, "x", encodeLayoutCoord(pos.X))
			appendKV(item, "y", encodeLayoutCoord(pos.Y))
			appendKV(nodes, id, item)
		}
		appendKV(n, "nodes", nodes)
	}
	return n
}

func encodeLayoutCoord(f float64) *yaml.Node {
	if math.Trunc(f) == f && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= math.MinInt64 && f <= math.MaxInt64 {
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprintf("%.0f", f)}
	}
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: strconvFormatFloat(f)}
}

func sortedLayoutNodeIDs(m map[string]UINodePosition) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func finiteNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint64:
		if n > math.MaxInt64 {
			return float64(n), isFinite(float64(n))
		}
		return float64(n), true
	case float64:
		if !isFinite(n) {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func finiteInt(v any) (int, bool) {
	f, ok := finiteNumber(v)
	if !ok || math.Trunc(f) != f {
		return 0, false
	}
	if f < math.MinInt || f > math.MaxInt {
		return 0, false
	}
	return int(f), true
}

func isFinite(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

func cloneAnyMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = cloneAny(v)
	}
	return out
}

func cloneAny(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return cloneAnyMap(t)
	case []any:
		out := make([]any, len(t))
		for i, item := range t {
			out[i] = cloneAny(item)
		}
		return out
	default:
		return t
	}
}
