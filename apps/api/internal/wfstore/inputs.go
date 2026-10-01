package wfstore

import (
	"encoding/json"
	"sort"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// succeededSnap is the latest succeeded attempt of one node.
// Output is output_redacted. With is the redacted step input, which a
// delay needs in order to evaluate duration. Plaintext output is never
// stored here.
type succeededSnap struct {
	NodeType string
	With     map[string]any
	Output   map[string]any
}

// resolveInputs applies the wired-input rule for nodeID.
// A satisfied edge sets inputs[to_port] from the upstream from_port.
// An unsatisfied edge contributes nothing: the key is absent, never null,
// and the port is recorded in skipped. flow.delay forwards Evaluate
// result: a map passes through, a scalar is wrapped as {"value": raw},
// and an unwired input is {}. flow.approval forwards its resolved
// request, or {} when that port is unwired. Values are cloned. The
// 16 KiB per-port cap stays inside Evaluate.
func resolveInputs(nodeID string, edges []execEdge, snaps map[string]succeededSnap) (map[string]any, []SkippedInput) {
	return resolveSeen(nodeID, edges, snaps, map[string]bool{})
}

func resolveSeen(nodeID string, edges []execEdge, snaps map[string]succeededSnap, stack map[string]bool) (map[string]any, []SkippedInput) {
	incoming := make([]execEdge, 0)
	for _, e := range edges {
		if e.ToNode == nodeID {
			incoming = append(incoming, e)
		}
	}
	sort.Slice(incoming, func(i, j int) bool {
		if incoming[i].ToPort != incoming[j].ToPort {
			return incoming[i].ToPort < incoming[j].ToPort
		}
		if incoming[i].FromNode != incoming[j].FromNode {
			return incoming[i].FromNode < incoming[j].FromNode
		}
		return incoming[i].FromPort < incoming[j].FromPort
	})
	var inputs map[string]any
	var skipped []SkippedInput
	for _, e := range incoming {
		if !e.Satisfied {
			skipped = append(skipped, SkippedInput{Port: e.ToPort, From: e.FromNode + "." + e.FromPort})
			continue
		}
		value, ok := valueFrom(e, edges, snaps, stack)
		if !ok || value == nil {
			continue
		}
		if inputs == nil {
			inputs = map[string]any{}
		}
		inputs[e.ToPort] = value
	}
	if len(skipped) == 0 {
		skipped = nil
	}
	return inputs, skipped
}

// valueFrom reads one satisfied edge. A wait node is resolved recursively
// from its own inputs. The stack is set only here, before that recursion,
// so the wait node's own resolveSeen still sees its upstream. A cycle
// omits the value. Nil and missing ports are omitted so a stored
// "false": null cannot flow. Empty string and boolean false do flow.
// An empty object from a wait node is present: it is not a missing port.
func valueFrom(e execEdge, edges []execEdge, snaps map[string]succeededSnap, stack map[string]bool) (any, bool) {
	snap, ok := snaps[e.FromNode]
	if !ok {
		return nil, false
	}
	if snap.NodeType == "flow.delay" || snap.NodeType == "flow.approval" {
		if stack[e.FromNode] {
			return nil, false
		}
		stack[e.FromNode] = true
		defer delete(stack, e.FromNode)
		nested, _ := resolveSeen(e.FromNode, edges, snaps, stack)
		if snap.NodeType == "flow.delay" {
			res, errs := workflow.Evaluate("flow.delay", snap.With, nested)
			if len(errs) > 0 || res == nil || res.Outputs == nil {
				return nil, false
			}
			return cloneInputValue(res.Outputs["result"])
		}
		if nested != nil {
			if value, present := nested["request"]; present && value != nil {
				return cloneInputValue(value)
			}
		}
		return cloneInputValue(map[string]any{})
	}
	if snap.Output == nil {
		return nil, false
	}
	value, present := snap.Output[e.FromPort]
	if !present || value == nil {
		return nil, false
	}
	return cloneInputValue(value)
}

func cloneInputValue(v any) (any, bool) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, false
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return nil, false
	}
	return out, true
}

// upstreamNodeIDs is the incoming-edge closure of nodeID, excluding
// nodeID. A wait node forwards a value computed from its own inputs, so
// the snap set includes the sources behind that gate and not only the
// direct predecessor. A node with no incoming edges returns nil.
func upstreamNodeIDs(nodeID string, edges []execEdge) []string {
	byTo := map[string][]string{}
	for _, e := range edges {
		byTo[e.ToNode] = append(byTo[e.ToNode], e.FromNode)
	}
	if len(byTo[nodeID]) == 0 {
		return nil
	}
	seen := map[string]bool{nodeID: true}
	var walk func(string)
	walk = func(id string) {
		for _, from := range byTo[id] {
			if seen[from] {
				continue
			}
			seen[from] = true
			walk(from)
		}
	}
	walk(nodeID)
	delete(seen, nodeID)
	if len(seen) == 0 {
		return nil
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// snapsFromSteps keeps the latest succeeded attempt of each id.
// An empty id list returns nil without scanning steps.
func snapsFromSteps(steps []ExecutionStep, ids []string) map[string]succeededSnap {
	if len(ids) == 0 {
		return nil
	}
	want := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		want[id] = struct{}{}
	}
	best := map[string]ExecutionStep{}
	for _, step := range steps {
		if _, ok := want[step.NodeID]; !ok || step.Status != ExecutionSucceeded {
			continue
		}
		prev, ok := best[step.NodeID]
		if !ok || step.Attempt > prev.Attempt {
			best[step.NodeID] = step
		}
	}
	if len(best) == 0 {
		return nil
	}
	out := make(map[string]succeededSnap, len(best))
	for id, step := range best {
		out[id] = succeededSnap{NodeType: step.NodeType, With: step.Input, Output: step.Output}
	}
	return out
}
