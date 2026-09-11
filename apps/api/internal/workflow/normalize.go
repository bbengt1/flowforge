package workflow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Normalize emits deterministic YAML for a validated document and its SHA-256
// digest. Literal block content such as manifests and source keeps exact inner
// text except a single trailing newline.
func Normalize(doc *Document) (string, string, error) {
	if doc == nil {
		return "", "", fmt.Errorf("document is required")
	}
	root := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	appendKV(root, "apiVersion", plainScalar(doc.APIVersion))
	appendKV(root, "kind", plainScalar(doc.Kind))
	appendKV(root, "metadata", encodeMetadata(doc.Metadata))
	appendKV(root, "spec", encodeSpec(doc.Spec))

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		_ = enc.Close()
		return "", "", err
	}
	if err := enc.Close(); err != nil {
		return "", "", err
	}
	out := buf.String()
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return out, Digest(out), nil
}

// Digest returns the sha256:<hex> fingerprint of normalized YAML.
func Digest(normalizedYAML string) string {
	sum := sha256.Sum256([]byte(normalizedYAML))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func encodeMetadata(md Metadata) *yaml.Node {
	n := mappingNode()
	appendKV(n, "name", plainScalar(md.Name))
	if len(md.Labels) > 0 {
		labels := mappingNode()
		for _, k := range sortedKeys(md.Labels) {
			appendKV(labels, k, stringScalar(md.Labels[k]))
		}
		appendKV(n, "labels", labels)
	}
	if ui := encodeUI(md.UI); ui != nil {
		appendKV(n, "ui", ui)
	}
	return n
}

func encodeSpec(spec Spec) *yaml.Node {
	n := mappingNode()
	if spec.Description != "" {
		appendKV(n, "description", stringScalar(spec.Description))
	}

	triggers := sequenceNode()
	for _, t := range sortTriggers(spec.Triggers) {
		item := mappingNode()
		appendKV(item, "id", plainScalar(t.ID))
		appendKV(item, "type", plainScalar(t.Type))
		for _, k := range sortedAnyKeys(t.With) {
			appendKV(item, k, encodeValue(t.With[k]))
		}
		triggers.Content = append(triggers.Content, item)
	}
	appendKV(n, "triggers", triggers)

	nodes := sequenceNode()
	for _, node := range sortNodes(spec.Nodes) {
		item := mappingNode()
		appendKV(item, "id", plainScalar(node.ID))
		appendKV(item, "type", plainScalar(node.Type))
		appendKV(item, "name", stringScalar(node.Name))
		if len(node.With) > 0 {
			appendKV(item, "with", encodeMap(node.With))
		}
		if len(node.Inputs) > 0 {
			appendKV(item, "inputs", encodeMap(node.Inputs))
		}
		nodes.Content = append(nodes.Content, item)
	}
	appendKV(n, "nodes", nodes)

	edges := sequenceNode()
	for _, e := range sortEdges(spec.Edges) {
		item := mappingNode()
		appendKV(item, "from", plainScalar(e.From))
		appendKV(item, "to", plainScalar(e.To))
		edges.Content = append(edges.Content, item)
	}
	appendKV(n, "edges", edges)

	if len(spec.Outputs) > 0 {
		outputs := sequenceNode()
		for _, o := range sortOutputs(spec.Outputs) {
			item := mappingNode()
			appendKV(item, "name", plainScalar(o.Name))
			appendKV(item, "from", plainScalar(o.From))
			outputs.Content = append(outputs.Content, item)
		}
		appendKV(n, "outputs", outputs)
	}
	return n
}

func encodeMap(m map[string]any) *yaml.Node {
	n := mappingNode()
	for _, k := range sortedAnyKeys(m) {
		appendKV(n, k, encodeValue(m[k]))
	}
	return n
}

func encodeValue(v any) *yaml.Node {
	switch t := v.(type) {
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
	case string:
		return stringScalar(t)
	case bool:
		if t {
			return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"}
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "false"}
	case int:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprintf("%d", t)}
	case int64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprintf("%d", t)}
	case uint64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprintf("%d", t)}
	case float64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: strconvFormatFloat(t)}
	case []any:
		n := sequenceNode()
		for _, item := range t {
			n.Content = append(n.Content, encodeValue(item))
		}
		return n
	case map[string]any:
		return encodeMap(t)
	default:
		return stringScalar(fmt.Sprint(t))
	}
}

func stringScalar(s string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: normalizeTrailingNewline(s)}
	if strings.Contains(n.Value, "\n") {
		n.Style = yaml.LiteralStyle
	}
	return n
}

func plainScalar(s string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s}
}

func normalizeTrailingNewline(s string) string {
	if !strings.Contains(s, "\n") {
		return s
	}
	return strings.TrimRight(s, "\n") + "\n"
}

func mappingNode() *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
}

func sequenceNode() *yaml.Node {
	return &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
}

func appendKV(n *yaml.Node, key string, value *yaml.Node) {
	n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
}

func sortTriggers(in []Trigger) []Trigger {
	out := append([]Trigger(nil), in...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func sortNodes(in []Node) []Node {
	out := append([]Node(nil), in...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func sortEdges(in []Edge) []Edge {
	out := append([]Edge(nil), in...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].From == out[j].From {
			return out[i].To < out[j].To
		}
		return out[i].From < out[j].From
	})
	return out
}

func sortOutputs(in []Output) []Output {
	out := append([]Output(nil), in...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortedAnyKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func strconvFormatFloat(f float64) string {
	s := strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", f), "0"), ".")
	if s == "" || s == "-" {
		return "0"
	}
	if !strings.Contains(s, ".") {
		s += ".0"
	}
	return s
}
