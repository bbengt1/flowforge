package opsconfig

import (
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"gopkg.in/yaml.v3"
)

// ExtractRefs parses normalized workflow YAML and returns unique resource refs.
// Unknown or non-UUID values are ignored; authorization happens at Resolve.
func ExtractRefs(definitionYAML string) []Ref {
	res, errs := workflow.ParseAndNormalize([]byte(definitionYAML))
	if len(errs) == 0 && res != nil && res.Document != nil {
		return extractFromNormalized(res)
	}
	return extractFromRawYAML(definitionYAML)
}

func extractFromNormalized(res *workflow.Result) []Ref {
	var refs []Ref
	seen := map[string]struct{}{}
	add := func(kind, id string) {
		id = strings.TrimSpace(id)
		if kind == "" || !authz.ValidUUID(id) {
			return
		}
		key := kind + "\x00" + id
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		refs = append(refs, Ref{Kind: kind, ResourceID: id})
	}
	for _, node := range res.Document.Spec.Nodes {
		for field, raw := range node.With {
			kind := YAMLFieldKind(field)
			if kind == "" {
				continue
			}
			id, _ := raw.(string)
			add(kind, id)
		}
	}
	return refs
}

func extractFromRawYAML(definitionYAML string) []Ref {
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(definitionYAML), &doc); err != nil {
		return nil
	}
	spec, _ := doc["spec"].(map[string]any)
	if spec == nil {
		return nil
	}
	nodes, _ := spec["nodes"].([]any)
	var refs []Ref
	seen := map[string]struct{}{}
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		with, _ := node["with"].(map[string]any)
		for field, val := range with {
			kind := YAMLFieldKind(field)
			id, _ := val.(string)
			id = strings.TrimSpace(id)
			if kind == "" || !authz.ValidUUID(id) {
				continue
			}
			key := kind + "\x00" + id
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			refs = append(refs, Ref{Kind: kind, ResourceID: id})
		}
	}
	return refs
}
