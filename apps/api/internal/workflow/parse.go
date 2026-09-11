package workflow

import (
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

var (
	dnsLabelRE  = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)
	uuidRE      = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	portRefRE   = regexp.MustCompile(`^([a-z]([a-z0-9-]{0,61}[a-z0-9])?)\.([A-Za-z][A-Za-z0-9_]*)$`)
	templateRE  = regexp.MustCompile(`\{\{|}}|\{%|%\}|\$\{|<%`)
	unsafeKeyRE = regexp.MustCompile(`(?i)^(password|passwd|secret|secrets|token|api[_-]?key|private[_-]?key|credential|credentials|authorization|auth[_-]?header|kubeconfig|access[_-]?key|refresh[_-]?token|client[_-]?secret)$`)
)

var allowedYAMLTags = map[string]bool{
	"":        true,
	"!":       true,
	"!!str":   true,
	"!!int":   true,
	"!!float": true,
	"!!bool":  true,
	"!!null":  true,
	"!!map":   true,
	"!!seq":   true,
}

var topLevelKeys = map[string]bool{
	"apiVersion": true,
	"kind":       true,
	"metadata":   true,
	"spec":       true,
}

var metadataKeys = map[string]bool{
	"name":   true,
	"labels": true,
	"ui":     true,
}

var specKeys = map[string]bool{
	"description": true,
	"triggers":    true,
	"nodes":       true,
	"edges":       true,
	"outputs":     true,
}

var nodeKeys = map[string]bool{
	"id":     true,
	"type":   true,
	"name":   true,
	"with":   true,
	"inputs": true,
}

var triggerKeys = map[string]bool{
	"id":   true,
	"type": true,
}

var edgeKeys = map[string]bool{
	"from": true,
	"to":   true,
}

var outputKeys = map[string]bool{
	"name": true,
	"from": true,
}

// Parse safely decodes a single workflow YAML document, validates the typed
// graph, and returns a Document ready for normalization.
func Parse(src []byte) (*Document, ErrorList) {
	if len(src) > MaxDocumentBytes {
		return nil, ErrorList{fieldError("", 0, 0, CodeDocumentTooLarge, fmt.Sprintf("Workflow YAML exceeds the %d byte parser limit.", MaxDocumentBytes))}
	}
	if len(bytes.TrimSpace(src)) == 0 {
		return nil, ErrorList{fieldError("", 0, 0, CodeMalformedYAML, "Workflow YAML is required.")}
	}

	dec := yaml.NewDecoder(bytes.NewReader(src))
	var root yaml.Node
	if err := dec.Decode(&root); err != nil {
		return nil, ErrorList{yamlSyntaxError(err)}
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, ErrorList{fieldError("", extra.Line, extra.Column, CodeMultipleDocuments, "Only one workflow document is allowed.")}
		}
		return nil, ErrorList{yamlSyntaxError(err)}
	}

	var errs ErrorList
	if err := walkSafe(&root, "", 0, &nodeCount{}, &errs); err != nil {
		errs = append(errs, *err)
	}
	if len(errs) > 0 {
		return nil, errs
	}

	docNode := documentMapping(&root)
	if docNode == nil {
		return nil, ErrorList{fieldError("", root.Line, root.Column, CodeMalformedYAML, "Workflow YAML must be a mapping.")}
	}

	doc, decodeErrs := decodeDocument(docNode)
	errs = append(errs, decodeErrs...)
	if doc == nil {
		return nil, errs
	}
	errs = append(errs, validate(doc)...)
	if len(errs) > 0 {
		return nil, errs
	}
	return doc, nil
}

// ParseAndNormalize parses, validates, and emits deterministic YAML plus digest.
func ParseAndNormalize(src []byte) (*Result, ErrorList) {
	doc, errs := Parse(src)
	if len(errs) > 0 {
		return nil, errs
	}
	normalized, digest, err := Normalize(doc)
	if err != nil {
		return nil, ErrorList{fieldError("", 0, 0, CodeMalformedYAML, "Workflow YAML could not be normalized.")}
	}
	return &Result{
		Document:       doc,
		NormalizedYAML: normalized,
		Digest:         digest,
		Summary:        doc.Summary(),
		Warnings:       []FieldError{},
	}, nil
}

type nodeCount struct {
	n int
}

func walkSafe(n *yaml.Node, path string, depth int, count *nodeCount, errs *ErrorList) *FieldError {
	if n == nil {
		return nil
	}
	if n.Kind == yaml.DocumentNode {
		if len(n.Content) != 1 {
			return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeMalformedYAML, Message: "Workflow YAML must contain exactly one document mapping."}
		}
		return walkSafe(n.Content[0], path, depth, count, errs)
	}
	count.n++
	if count.n > MaxYAMLNodes {
		return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeNodeLimit, Message: fmt.Sprintf("Workflow YAML exceeds the %d node parser limit.", MaxYAMLNodes)}
	}
	if depth > MaxDepth {
		return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeDepthLimit, Message: fmt.Sprintf("Workflow YAML exceeds the depth limit of %d.", MaxDepth)}
	}
	if n.Kind == yaml.AliasNode {
		return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeAliasForbidden, Message: "YAML aliases and anchors are not allowed."}
	}
	if !allowedYAMLTags[n.Tag] {
		return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeUnsupportedTag, Message: "Custom YAML tags are not allowed."}
	}
	if n.Kind == yaml.ScalarNode {
		if len(n.Value) > MaxScalarBytes {
			return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeScalarTooLarge, Message: fmt.Sprintf("Scalar exceeds the %d byte limit.", MaxScalarBytes)}
		}
		if templateRE.MatchString(n.Value) {
			return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeTemplateForbidden, Message: "YAML templating and expressions are not allowed."}
		}
		return nil
	}
	if n.Kind == yaml.SequenceNode {
		for i, child := range n.Content {
			if err := walkSafe(child, indexPath(path, i), depth+1, count, errs); err != nil {
				return err
			}
		}
		return nil
	}
	if n.Kind == yaml.MappingNode {
		seen := map[string]loc{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			if k.Kind != yaml.ScalarNode {
				return &FieldError{Path: path, Line: k.Line, Column: k.Column, Code: CodeInvalidType, Message: "Mapping keys must be strings."}
			}
			if k.Value == "<<" {
				return &FieldError{Path: joinPath(path, k.Value), Line: k.Line, Column: k.Column, Code: CodeUnsupportedTag, Message: "YAML merge keys are not allowed."}
			}
			if templateRE.MatchString(k.Value) {
				return &FieldError{Path: joinPath(path, k.Value), Line: k.Line, Column: k.Column, Code: CodeTemplateForbidden, Message: "YAML templating and expressions are not allowed."}
			}
			if prev, ok := seen[k.Value]; ok {
				*errs = append(*errs, fieldError(joinPath(path, k.Value), k.Line, k.Column, CodeDuplicateKey, fmt.Sprintf("Duplicate key %q (first seen at line %d).", k.Value, prev.Line)))
				continue
			}
			seen[k.Value] = loc{Line: k.Line, Column: k.Column}
			if err := walkSafe(k, joinPath(path, k.Value), depth+1, count, errs); err != nil {
				return err
			}
			if err := walkSafe(v, joinPath(path, k.Value), depth+1, count, errs); err != nil {
				return err
			}
		}
		return nil
	}
	return &FieldError{Path: path, Line: n.Line, Column: n.Column, Code: CodeMalformedYAML, Message: "Unsupported YAML node."}
}

func documentMapping(root *yaml.Node) *yaml.Node {
	if root == nil {
		return nil
	}
	if root.Kind == yaml.DocumentNode && len(root.Content) == 1 {
		root = root.Content[0]
	}
	if root.Kind != yaml.MappingNode {
		return nil
	}
	return root
}

func decodeDocument(n *yaml.Node) (*Document, ErrorList) {
	var errs ErrorList
	doc := &Document{pos: positions{root: nodeLoc(n)}}
	keys := mappingKeys(n)
	for _, k := range keys {
		if !topLevelKeys[k.key] {
			errs = append(errs, fieldError(k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q.", k.key)))
		}
	}

	if v, ok := mappingValue(n, "apiVersion"); ok {
		if s, err := scalarString(v, "apiVersion"); err != nil {
			errs = append(errs, *err)
		} else {
			doc.APIVersion = s
		}
	} else {
		errs = append(errs, fieldError("apiVersion", n.Line, n.Column, CodeMissingField, "apiVersion is required."))
	}

	if v, ok := mappingValue(n, "kind"); ok {
		if s, err := scalarString(v, "kind"); err != nil {
			errs = append(errs, *err)
		} else {
			doc.Kind = s
		}
	} else {
		errs = append(errs, fieldError("kind", n.Line, n.Column, CodeMissingField, "kind is required."))
	}

	if v, ok := mappingValue(n, "metadata"); ok {
		doc.pos.metadata = nodeLoc(v)
		md, mdErrs := decodeMetadata(v)
		doc.Metadata = md
		errs = append(errs, mdErrs...)
	} else {
		errs = append(errs, fieldError("metadata", n.Line, n.Column, CodeMissingField, "metadata is required."))
	}

	if v, ok := mappingValue(n, "spec"); ok {
		doc.pos.spec = nodeLoc(v)
		spec, specErrs := decodeSpec(v)
		doc.Spec = spec
		errs = append(errs, specErrs...)
	} else {
		errs = append(errs, fieldError("spec", n.Line, n.Column, CodeMissingField, "spec is required."))
	}

	bindLayoutToSpec(doc)

	if len(errs) > 0 {
		return doc, errs
	}
	return doc, nil
}

func decodeMetadata(n *yaml.Node) (Metadata, ErrorList) {
	var md Metadata
	var errs ErrorList
	if n.Kind != yaml.MappingNode {
		return md, ErrorList{fieldError("metadata", n.Line, n.Column, CodeInvalidType, "metadata must be a mapping.")}
	}
	for _, k := range mappingKeys(n) {
		if !metadataKeys[k.key] {
			errs = append(errs, fieldError("metadata."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q.", k.key)))
		}
	}
	if v, ok := mappingValue(n, "name"); ok {
		if s, err := scalarString(v, "metadata.name"); err != nil {
			errs = append(errs, *err)
		} else {
			md.Name = s
		}
	} else {
		errs = append(errs, fieldError("metadata.name", n.Line, n.Column, CodeMissingField, "metadata.name is required."))
	}
	if v, ok := mappingValue(n, "labels"); ok {
		labels, labelErrs := decodeStringMap(v, "metadata.labels")
		md.Labels = labels
		errs = append(errs, labelErrs...)
		if len(md.Labels) > MaxLabels {
			errs = append(errs, fieldError("metadata.labels", v.Line, v.Column, CodeNodeLimit, fmt.Sprintf("metadata.labels exceeds the limit of %d.", MaxLabels)))
		}
	}
	if v, ok := mappingValue(n, "ui"); ok {
		ui, uiErrs := decodeUI(v)
		md.UI = ui
		errs = append(errs, uiErrs...)
	}
	return md, errs
}

func decodeSpec(n *yaml.Node) (Spec, ErrorList) {
	var spec Spec
	var errs ErrorList
	if n.Kind != yaml.MappingNode {
		return spec, ErrorList{fieldError("spec", n.Line, n.Column, CodeInvalidType, "spec must be a mapping.")}
	}
	for _, k := range mappingKeys(n) {
		if !specKeys[k.key] {
			errs = append(errs, fieldError("spec."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q.", k.key)))
		}
	}
	if v, ok := mappingValue(n, "description"); ok {
		if s, err := scalarString(v, "spec.description"); err != nil {
			errs = append(errs, *err)
		} else {
			spec.Description = s
		}
	}
	if v, ok := mappingValue(n, "triggers"); ok {
		items, itemErrs := decodeSequence(v, "spec.triggers", decodeTrigger)
		spec.Triggers = items
		errs = append(errs, itemErrs...)
		if len(spec.Triggers) > MaxTriggers {
			errs = append(errs, fieldError("spec.triggers", v.Line, v.Column, CodeNodeLimit, fmt.Sprintf("spec.triggers exceeds the limit of %d.", MaxTriggers)))
		}
	} else {
		errs = append(errs, fieldError("spec.triggers", n.Line, n.Column, CodeMissingField, "spec.triggers is required."))
	}
	if v, ok := mappingValue(n, "nodes"); ok {
		items, itemErrs := decodeSequence(v, "spec.nodes", decodeNode)
		spec.Nodes = items
		errs = append(errs, itemErrs...)
		if len(spec.Nodes) > MaxWorkflowNodes {
			errs = append(errs, fieldError("spec.nodes", v.Line, v.Column, CodeNodeLimit, fmt.Sprintf("spec.nodes exceeds the limit of %d.", MaxWorkflowNodes)))
		}
	} else {
		errs = append(errs, fieldError("spec.nodes", n.Line, n.Column, CodeMissingField, "spec.nodes is required."))
	}
	if v, ok := mappingValue(n, "edges"); ok {
		items, itemErrs := decodeSequence(v, "spec.edges", decodeEdge)
		spec.Edges = items
		errs = append(errs, itemErrs...)
		if len(spec.Edges) > MaxEdges {
			errs = append(errs, fieldError("spec.edges", v.Line, v.Column, CodeNodeLimit, fmt.Sprintf("spec.edges exceeds the limit of %d.", MaxEdges)))
		}
	}
	if v, ok := mappingValue(n, "outputs"); ok {
		items, itemErrs := decodeSequence(v, "spec.outputs", decodeOutput)
		spec.Outputs = items
		errs = append(errs, itemErrs...)
		if len(spec.Outputs) > MaxOutputs {
			errs = append(errs, fieldError("spec.outputs", v.Line, v.Column, CodeNodeLimit, fmt.Sprintf("spec.outputs exceeds the limit of %d.", MaxOutputs)))
		}
	}
	return spec, errs
}

func decodeTrigger(n *yaml.Node, path string) (Trigger, ErrorList) {
	var t Trigger
	var errs ErrorList
	t.pos = nodeLoc(n)
	if n.Kind != yaml.MappingNode {
		return t, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, "Trigger must be a mapping.")}
	}
	if v, ok := mappingValue(n, "id"); ok {
		if s, err := scalarString(v, path+".id"); err != nil {
			errs = append(errs, *err)
		} else {
			t.ID = s
		}
	} else {
		errs = append(errs, fieldError(path+".id", n.Line, n.Column, CodeMissingField, "Trigger id is required."))
	}
	if v, ok := mappingValue(n, "type"); ok {
		if s, err := scalarString(v, path+".type"); err != nil {
			errs = append(errs, *err)
		} else {
			t.Type = s
		}
	} else {
		errs = append(errs, fieldError(path+".type", n.Line, n.Column, CodeMissingField, "Trigger type is required."))
	}
	with := map[string]any{}
	for _, k := range mappingKeys(n) {
		if triggerKeys[k.key] {
			continue
		}
		val, valErrs := decodeAny(k.node, path+"."+k.key)
		errs = append(errs, valErrs...)
		with[k.key] = val
	}
	if len(with) > 0 {
		t.With = with
	}
	return t, errs
}

func decodeNode(n *yaml.Node, path string) (Node, ErrorList) {
	var node Node
	var errs ErrorList
	node.pos = nodeLoc(n)
	if n.Kind != yaml.MappingNode {
		return node, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, "Node must be a mapping.")}
	}
	for _, k := range mappingKeys(n) {
		if !nodeKeys[k.key] {
			errs = append(errs, fieldError(path+"."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q.", k.key)))
		}
	}
	if v, ok := mappingValue(n, "id"); ok {
		if s, err := scalarString(v, path+".id"); err != nil {
			errs = append(errs, *err)
		} else {
			node.ID = s
		}
	} else {
		errs = append(errs, fieldError(path+".id", n.Line, n.Column, CodeMissingField, "Node id is required."))
	}
	if v, ok := mappingValue(n, "type"); ok {
		if s, err := scalarString(v, path+".type"); err != nil {
			errs = append(errs, *err)
		} else {
			node.Type = s
		}
	} else {
		errs = append(errs, fieldError(path+".type", n.Line, n.Column, CodeMissingField, "Node type is required."))
	}
	if v, ok := mappingValue(n, "name"); ok {
		if s, err := scalarString(v, path+".name"); err != nil {
			errs = append(errs, *err)
		} else {
			node.Name = s
		}
	} else {
		errs = append(errs, fieldError(path+".name", n.Line, n.Column, CodeMissingField, "Node name is required."))
	}
	if v, ok := mappingValue(n, "with"); ok {
		m, mErrs := decodeAnyMap(v, path+".with")
		node.With = m
		errs = append(errs, mErrs...)
		if len(node.With) > MaxWithKeys {
			errs = append(errs, fieldError(path+".with", v.Line, v.Column, CodeNodeLimit, fmt.Sprintf("with exceeds the limit of %d keys.", MaxWithKeys)))
		}
	}
	if v, ok := mappingValue(n, "inputs"); ok {
		m, mErrs := decodeAnyMap(v, path+".inputs")
		node.Inputs = m
		errs = append(errs, mErrs...)
	}
	return node, errs
}

func decodeEdge(n *yaml.Node, path string) (Edge, ErrorList) {
	var e Edge
	var errs ErrorList
	e.pos = nodeLoc(n)
	if n.Kind != yaml.MappingNode {
		return e, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, "Edge must be a mapping.")}
	}
	for _, k := range mappingKeys(n) {
		if !edgeKeys[k.key] {
			errs = append(errs, fieldError(path+"."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q.", k.key)))
		}
	}
	if v, ok := mappingValue(n, "from"); ok {
		if s, err := scalarString(v, path+".from"); err != nil {
			errs = append(errs, *err)
		} else {
			e.From = s
		}
	} else {
		errs = append(errs, fieldError(path+".from", n.Line, n.Column, CodeMissingField, "Edge from is required."))
	}
	if v, ok := mappingValue(n, "to"); ok {
		if s, err := scalarString(v, path+".to"); err != nil {
			errs = append(errs, *err)
		} else {
			e.To = s
		}
	} else {
		errs = append(errs, fieldError(path+".to", n.Line, n.Column, CodeMissingField, "Edge to is required."))
	}
	return e, errs
}

func decodeOutput(n *yaml.Node, path string) (Output, ErrorList) {
	var o Output
	var errs ErrorList
	o.pos = nodeLoc(n)
	if n.Kind != yaml.MappingNode {
		return o, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, "Output must be a mapping.")}
	}
	for _, k := range mappingKeys(n) {
		if !outputKeys[k.key] {
			errs = append(errs, fieldError(path+"."+k.key, k.loc.Line, k.loc.Column, CodeUnknownField, fmt.Sprintf("Unknown field %q.", k.key)))
		}
	}
	if v, ok := mappingValue(n, "name"); ok {
		if s, err := scalarString(v, path+".name"); err != nil {
			errs = append(errs, *err)
		} else {
			o.Name = s
		}
	} else {
		errs = append(errs, fieldError(path+".name", n.Line, n.Column, CodeMissingField, "Output name is required."))
	}
	if v, ok := mappingValue(n, "from"); ok {
		if s, err := scalarString(v, path+".from"); err != nil {
			errs = append(errs, *err)
		} else {
			o.From = s
		}
	} else {
		errs = append(errs, fieldError(path+".from", n.Line, n.Column, CodeMissingField, "Output from is required."))
	}
	return o, errs
}

type mapKey struct {
	key  string
	loc  loc
	node *yaml.Node
}

func mappingKeys(n *yaml.Node) []mapKey {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	var out []mapKey
	for i := 0; i+1 < len(n.Content); i += 2 {
		k := n.Content[i]
		if k.Kind != yaml.ScalarNode {
			continue
		}
		out = append(out, mapKey{key: k.Value, loc: nodeLoc(k), node: n.Content[i+1]})
	}
	return out
}

func mappingValue(n *yaml.Node, key string) (*yaml.Node, bool) {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil, false
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Kind == yaml.ScalarNode && n.Content[i].Value == key {
			return n.Content[i+1], true
		}
	}
	return nil, false
}

func scalarString(n *yaml.Node, path string) (string, *FieldError) {
	if n.Kind != yaml.ScalarNode {
		err := fieldError(path, n.Line, n.Column, CodeInvalidType, path+" must be a string.")
		return "", &err
	}
	if n.Tag == "!!null" || n.Value == "" && n.Tag == "" && n.Style == 0 {
		// empty string is allowed; null is not for required identifiers
	}
	if n.Tag == "!!null" {
		err := fieldError(path, n.Line, n.Column, CodeInvalidType, path+" must be a string.")
		return "", &err
	}
	return n.Value, nil
}

func decodeStringMap(n *yaml.Node, path string) (map[string]string, ErrorList) {
	if n.Kind != yaml.MappingNode {
		return nil, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, path+" must be a string map.")}
	}
	out := map[string]string{}
	var errs ErrorList
	for _, k := range mappingKeys(n) {
		if s, err := scalarString(k.node, path+"."+k.key); err != nil {
			errs = append(errs, *err)
		} else {
			out[k.key] = s
		}
	}
	return out, errs
}

func decodeAnyMap(n *yaml.Node, path string) (map[string]any, ErrorList) {
	if n.Kind != yaml.MappingNode {
		return nil, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, path+" must be a mapping.")}
	}
	out := map[string]any{}
	var errs ErrorList
	for _, k := range mappingKeys(n) {
		v, vErrs := decodeAny(k.node, path+"."+k.key)
		errs = append(errs, vErrs...)
		out[k.key] = v
	}
	return out, errs
}

func decodeAny(n *yaml.Node, path string) (any, ErrorList) {
	switch n.Kind {
	case yaml.ScalarNode:
		return decodeScalar(n), nil
	case yaml.SequenceNode:
		var out []any
		var errs ErrorList
		for i, child := range n.Content {
			v, vErrs := decodeAny(child, indexPath(path, i))
			errs = append(errs, vErrs...)
			out = append(out, v)
		}
		if out == nil {
			out = []any{}
		}
		return out, errs
	case yaml.MappingNode:
		return decodeAnyMap(n, path)
	default:
		return nil, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, "Unsupported value.")}
	}
}

func decodeScalar(n *yaml.Node) any {
	switch n.Tag {
	case "!!null":
		return nil
	case "!!bool":
		v, err := strconv.ParseBool(n.Value)
		if err == nil {
			return v
		}
	case "!!int":
		v, err := strconv.ParseInt(n.Value, 0, 64)
		if err == nil {
			return v
		}
	case "!!float":
		v, err := strconv.ParseFloat(n.Value, 64)
		if err == nil {
			return v
		}
	}
	return n.Value
}

func decodeSequence[T any](n *yaml.Node, path string, fn func(*yaml.Node, string) (T, ErrorList)) ([]T, ErrorList) {
	if n.Kind != yaml.SequenceNode {
		return nil, ErrorList{fieldError(path, n.Line, n.Column, CodeInvalidType, path+" must be a sequence.")}
	}
	var out []T
	var errs ErrorList
	for i, child := range n.Content {
		item, itemErrs := fn(child, indexPath(path, i))
		errs = append(errs, itemErrs...)
		out = append(out, item)
	}
	return out, errs
}

func yamlSyntaxError(err error) FieldError {
	msg := "Workflow YAML is not valid."
	line, col := 0, 0
	if err != nil {
		// gopkg.in/yaml.v3 errors look like "yaml: line 3: ..."
		s := err.Error()
		if _, after, ok := strings.Cut(s, "yaml: line "); ok {
			num, rest, _ := strings.Cut(after, ":")
			if n, conv := atoi(num); conv {
				line = n
			}
			rest = strings.TrimSpace(rest)
			if rest != "" {
				msg = "Workflow YAML is not valid."
			}
		}
	}
	return fieldError("", line, col, CodeMalformedYAML, msg)
}

func atoi(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	return n, err == nil
}

func nodeLoc(n *yaml.Node) loc {
	if n == nil {
		return loc{}
	}
	return loc{Line: n.Line, Column: n.Column}
}

func joinPath(parent, key string) string {
	if parent == "" {
		return key
	}
	if key == "" {
		return parent
	}
	return parent + "." + key
}

func indexPath(parent string, i int) string {
	if parent == "" {
		return fmt.Sprintf("[%d]", i)
	}
	return fmt.Sprintf("%s[%d]", parent, i)
}

func parsePortRef(ref string) (PortRef, bool) {
	m := portRefRE.FindStringSubmatch(strings.TrimSpace(ref))
	if m == nil {
		return PortRef{}, false
	}
	return PortRef{NodeID: m[1], Port: m[3]}, true
}

func validDNSLabel(s string) bool {
	return dnsLabelRE.MatchString(s)
}

func validUUID(s string) bool {
	return uuidRE.MatchString(s)
}
