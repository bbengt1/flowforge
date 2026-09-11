package wfstore

import (
	"fmt"
	"sort"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const (
	RefDraft   = "draft"
	RefVersion = "version"
)

func compareDefinitions(leftRef, rightRef CompareRef, leftYAML, rightYAML, leftDigest, rightDigest string, left, right workflow.Summary) CompareResult {
	out := CompareResult{
		Left:        leftRef,
		Right:       rightRef,
		LeftDigest:  leftDigest,
		RightDigest: rightDigest,
		DigestMatch: leftDigest != "" && leftDigest == rightDigest,
		Changes:     []Change{},
	}
	if leftYAML == rightYAML && leftDigest == rightDigest {
		out.Equal = true
		return out
	}

	if left.Name != right.Name {
		out.Changes = append(out.Changes, Change{Path: "metadata.name", Op: "replace", Left: left.Name, Right: right.Name})
	}
	if left.Description != right.Description {
		out.Changes = append(out.Changes, Change{Path: "spec.description", Op: "replace", Left: left.Description, Right: right.Description})
	}

	out.Changes = append(out.Changes, diffTriggers(left.Triggers, right.Triggers)...)
	out.Changes = append(out.Changes, diffNodes(left.Nodes, right.Nodes)...)
	out.Changes = append(out.Changes, diffEdges(left.Edges, right.Edges)...)
	out.Changes = append(out.Changes, diffOutputs(left.Outputs, right.Outputs)...)
	out.Changes = append(out.Changes, diffLayout(left.UI, right.UI)...)

	if len(out.Changes) == 0 && !out.DigestMatch {
		out.Changes = append(out.Changes, Change{
			Path:  "definitionYaml",
			Op:    "replace",
			Left:  leftDigest,
			Right: rightDigest,
		})
	}
	out.Equal = len(out.Changes) == 0 && out.DigestMatch
	return out
}

func diffTriggers(left, right []workflow.TriggerSummary) []Change {
	lm := map[string]workflow.TriggerSummary{}
	rm := map[string]workflow.TriggerSummary{}
	for _, t := range left {
		lm[t.ID] = t
	}
	for _, t := range right {
		rm[t.ID] = t
	}
	var changes []Change
	for _, id := range sortedKeys(lm) {
		if _, ok := rm[id]; !ok {
			changes = append(changes, Change{Path: "spec.triggers[id=" + id + "]", Op: "remove", Left: lm[id]})
			continue
		}
		if lm[id].Type != rm[id].Type {
			changes = append(changes, Change{
				Path:  "spec.triggers[id=" + id + "].type",
				Op:    "replace",
				Left:  lm[id].Type,
				Right: rm[id].Type,
			})
		}
	}
	for _, id := range sortedKeys(rm) {
		if _, ok := lm[id]; !ok {
			changes = append(changes, Change{Path: "spec.triggers[id=" + id + "]", Op: "add", Right: rm[id]})
		}
	}
	return changes
}

func diffNodes(left, right []workflow.NodeSummary) []Change {
	lm := map[string]workflow.NodeSummary{}
	rm := map[string]workflow.NodeSummary{}
	for _, n := range left {
		lm[n.ID] = n
	}
	for _, n := range right {
		rm[n.ID] = n
	}
	var changes []Change
	for _, id := range sortedKeys(lm) {
		if _, ok := rm[id]; !ok {
			changes = append(changes, Change{Path: "spec.nodes[id=" + id + "]", Op: "remove", Left: lm[id]})
			continue
		}
		if lm[id].Type != rm[id].Type {
			changes = append(changes, Change{Path: "spec.nodes[id=" + id + "].type", Op: "replace", Left: lm[id].Type, Right: rm[id].Type})
		}
		if lm[id].Name != rm[id].Name {
			changes = append(changes, Change{Path: "spec.nodes[id=" + id + "].name", Op: "replace", Left: lm[id].Name, Right: rm[id].Name})
		}
	}
	for _, id := range sortedKeys(rm) {
		if _, ok := lm[id]; !ok {
			changes = append(changes, Change{Path: "spec.nodes[id=" + id + "]", Op: "add", Right: rm[id]})
		}
	}
	return changes
}

func diffEdges(left, right []workflow.EdgeSummary) []Change {
	lm := map[string]workflow.EdgeSummary{}
	rm := map[string]workflow.EdgeSummary{}
	for _, e := range left {
		lm[e.From+"->"+e.To] = e
	}
	for _, e := range right {
		rm[e.From+"->"+e.To] = e
	}
	var changes []Change
	for _, key := range sortedKeys(lm) {
		if _, ok := rm[key]; !ok {
			changes = append(changes, Change{Path: "spec.edges[" + key + "]", Op: "remove", Left: lm[key]})
		}
	}
	for _, key := range sortedKeys(rm) {
		if _, ok := lm[key]; !ok {
			changes = append(changes, Change{Path: "spec.edges[" + key + "]", Op: "add", Right: rm[key]})
		}
	}
	return changes
}

func diffOutputs(left, right []workflow.OutputSummary) []Change {
	lm := map[string]workflow.OutputSummary{}
	rm := map[string]workflow.OutputSummary{}
	for _, o := range left {
		lm[o.Name] = o
	}
	for _, o := range right {
		rm[o.Name] = o
	}
	var changes []Change
	for _, name := range sortedKeys(lm) {
		if _, ok := rm[name]; !ok {
			changes = append(changes, Change{Path: "spec.outputs[name=" + name + "]", Op: "remove", Left: lm[name]})
			continue
		}
		if lm[name].From != rm[name].From {
			changes = append(changes, Change{Path: "spec.outputs[name=" + name + "].from", Op: "replace", Left: lm[name].From, Right: rm[name].From})
		}
	}
	for _, name := range sortedKeys(rm) {
		if _, ok := lm[name]; !ok {
			changes = append(changes, Change{Path: "spec.outputs[name=" + name + "]", Op: "add", Right: rm[name]})
		}
	}
	return changes
}

func diffLayout(left, right *workflow.UISummary) []Change {
	lp := layoutPathValue(left)
	rp := layoutPathValue(right)
	if lp == rp {
		return nil
	}
	if lp == "" {
		return []Change{{Path: "metadata.ui.layout", Op: "add", Right: rp}}
	}
	if rp == "" {
		return []Change{{Path: "metadata.ui.layout", Op: "remove", Left: lp}}
	}
	return []Change{{Path: "metadata.ui.layout", Op: "replace", Left: lp, Right: rp}}
}

func layoutPathValue(ui *workflow.UISummary) string {
	if ui == nil || ui.Layout == nil {
		return ""
	}
	ids := make([]string, 0, len(ui.Layout.Nodes))
	for id := range ui.Layout.Nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	parts := make([]string, 0, len(ids)+1)
	parts = append(parts, fmt.Sprintf("v%d", ui.Layout.Version))
	for _, id := range ids {
		pos := ui.Layout.Nodes[id]
		parts = append(parts, fmt.Sprintf("%s=%g,%g", id, pos.X, pos.Y))
	}
	return strings.Join(parts, ";")
}

func sortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
