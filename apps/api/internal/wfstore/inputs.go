package wfstore

import (
	"encoding/json"
	"sort"
)

// succeededSnap is the latest succeeded attempt of one node.
// Output is output_redacted. Plaintext output is never stored here.
type succeededSnap struct {
	NodeType string
	Output   map[string]any
}

// resolveInputs applies the wired-input rule for nodeID.
// A satisfied edge sets inputs[to_port] from the upstream from_port.
// An unsatisfied edge contributes nothing: the key is absent, never null,
// and the port is recorded in skipped. Wait nodes (flow.approval,
// flow.delay) pass their own resolved input out the fired port. Values
// are cloned. The 16 KiB per-port cap stays in evaluation; this function
// does not drop or truncate oversized values.
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
// from its own input port. The stack is set only here, before that
// recursion, so the wait node's own resolveSeen still sees its upstream.
// A cycle omits the value. Nil and missing ports are omitted so a stored
// "false": null cannot flow. Empty string and boolean false do flow.
func valueFrom(e execEdge, edges []execEdge, snaps map[string]succeededSnap, stack map[string]bool) (any, bool) {
	snap, ok := snaps[e.FromNode]
	if !ok {
		return nil, false
	}
	if snap.NodeType == "flow.approval" || snap.NodeType == "flow.delay" {
		if stack[e.FromNode] {
			return nil, false
		}
		stack[e.FromNode] = true
		defer delete(stack, e.FromNode)
		nested, _ := resolveSeen(e.FromNode, edges, snaps, stack)
		port := "input"
		if snap.NodeType == "flow.approval" {
			port = "request"
		}
		if nested == nil {
			return nil, false
		}
		value, present := nested[port]
		if !present || value == nil {
			return nil, false
		}
		return cloneInputValue(value)
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

func snapsFromSteps(steps []ExecutionStep) map[string]succeededSnap {
	best := map[string]ExecutionStep{}
	for _, step := range steps {
		if step.Status != ExecutionSucceeded {
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
		out[id] = succeededSnap{NodeType: step.NodeType, Output: step.Output}
	}
	return out
}
