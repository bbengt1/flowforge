package wfstore

import (
	"regexp"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// execEdge is one published port connection pinned to a run.
// The workflow schema wires ports at publish time and does not define a
// runtime join mode (flow.join is registry-disabled). Required is true
// for every edge that leaves a flow.approval node: that edge must be
// satisfied or the target is skipped. Every other edge uses the
// satisfied-any rule once all incoming edges have resolved.
type execEdge struct {
	ID        string
	FromNode  string
	FromPort  string
	ToNode    string
	ToPort    string
	Required  bool
	Resolved  bool
	Satisfied bool
}

var portRefRE = regexp.MustCompile(`^([a-z]([a-z0-9-]{0,61}[a-z0-9])?)\.([A-Za-z][A-Za-z0-9_]*)$`)

type portRef struct {
	NodeID string
	Port   string
}

func splitPort(ref string) (portRef, bool) {
	m := portRefRE.FindStringSubmatch(strings.TrimSpace(ref))
	if m == nil {
		return portRef{}, false
	}
	return portRef{NodeID: m[1], Port: m[3]}, true
}

// planGraph reads nodes and edges from the published YAML. A summary
// fallback is used only when the YAML does not parse. A malformed edge
// fails closed so a node cannot start early.
func planGraph(yamlDoc string, summary workflow.Summary) ([]plannedNode, []execEdge, error) {
	nodes := planNodes(yamlDoc, summary)
	types := make(map[string]string, len(nodes))
	for _, n := range nodes {
		types[n.ID] = n.Type
	}
	raw := summary.Edges
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) == 0 && res != nil && res.Document != nil {
		raw = make([]workflow.EdgeSummary, 0, len(res.Document.Spec.Edges))
		for _, e := range res.Document.Spec.Edges {
			raw = append(raw, workflow.EdgeSummary{From: e.From, To: e.To})
		}
	}
	edges := make([]execEdge, 0, len(raw))
	for _, e := range raw {
		from, ok := splitPort(e.From)
		if !ok {
			return nil, nil, ErrInvalid
		}
		to, ok := splitPort(e.To)
		if !ok {
			return nil, nil, ErrInvalid
		}
		edges = append(edges, execEdge{
			FromNode: from.NodeID,
			FromPort: from.Port,
			ToNode:   to.NodeID,
			ToPort:   to.Port,
			Required: types[from.NodeID] == "flow.approval",
		})
	}
	return nodes, edges, nil
}

// emittedPorts is the set of ports a finished step actually produced.
// A non-empty output.port selects that port alone. Otherwise every key
// whose value is non-nil counts as emitted.
func emittedPorts(output map[string]any) map[string]struct{} {
	out := map[string]struct{}{}
	if output == nil {
		return out
	}
	if port, ok := output["port"].(string); ok && strings.TrimSpace(port) != "" {
		out[strings.TrimSpace(port)] = struct{}{}
		return out
	}
	for k, v := range output {
		if v == nil {
			continue
		}
		out[k] = struct{}{}
	}
	return out
}

func waitExpiryPort(nodeType string) string {
	if nodeType == "flow.delay" {
		return "result"
	}
	return "expired"
}

func countQueuedJobs(jobs []ExecutionJob) int {
	n := 0
	for _, job := range jobs {
		if job.Status == JobQueued {
			n++
		}
	}
	return n
}

// releaseFrom resolves every still-open edge that leaves nodeID.
// An edge is satisfied only when ports contains its from-port.
// A required edge that resolves unsatisfied skips the target immediately.
// Otherwise the target waits until every incoming edge has resolved, then
// queues if at least one was satisfied and skips if none were. A skip
// resolves the skipped node's outgoing edges as unsatisfied.
func releaseFrom(steps []ExecutionStep, jobs []ExecutionJob, edges []execEdge, nodeID string, ports map[string]struct{}, now time.Time) {
	type item struct {
		node  string
		ports map[string]struct{}
	}
	work := []item{{node: nodeID, ports: ports}}
	released := map[string]bool{}
	for len(work) > 0 {
		cur := work[0]
		work = work[1:]
		if cur.node == "" || released[cur.node] {
			continue
		}
		released[cur.node] = true
		targets := map[string]struct{}{}
		for i := range edges {
			e := &edges[i]
			if e.FromNode != cur.node || e.Resolved {
				continue
			}
			e.Resolved = true
			_, sat := cur.ports[e.FromPort]
			e.Satisfied = sat
			idx := latestStepIndex(steps, e.ToNode)
			if idx >= 0 && steps[idx].UnresolvedIncoming > 0 {
				steps[idx].UnresolvedIncoming--
				steps[idx].UpdatedAt = now
			}
			targets[e.ToNode] = struct{}{}
		}
		for target := range targets {
			if skipped := reconsiderTarget(steps, jobs, edges, target, now); skipped {
				work = append(work, item{node: target, ports: map[string]struct{}{}})
			}
		}
	}
}

func reconsiderTarget(steps []ExecutionStep, jobs []ExecutionJob, edges []execEdge, node string, now time.Time) bool {
	idx := latestStepIndex(steps, node)
	if idx < 0 || steps[idx].Status != ExecutionPending {
		return false
	}
	unresolved := 0
	satisfied := 0
	requiredFail := false
	for _, e := range edges {
		if e.ToNode != node {
			continue
		}
		if !e.Resolved {
			unresolved++
			continue
		}
		if e.Satisfied {
			satisfied++
			continue
		}
		if e.Required {
			requiredFail = true
		}
	}
	if requiredFail {
		markStepSkipped(&steps[idx], jobs, now)
		return true
	}
	if unresolved > 0 {
		return false
	}
	if satisfied > 0 {
		markStepQueued(&steps[idx], jobs, now)
		return false
	}
	markStepSkipped(&steps[idx], jobs, now)
	return true
}

func markStepQueued(step *ExecutionStep, jobs []ExecutionJob, now time.Time) {
	step.UnresolvedIncoming = 0
	applyStepStatus(step, ExecutionQueued, now)
	jidx := jobIndexForStep(jobs, step.ID)
	if jidx < 0 {
		return
	}
	if jobs[jidx].Status != JobBlocked {
		return
	}
	jobs[jidx].Status = JobQueued
	jobs[jidx].AvailableAt = now
	jobs[jidx].UpdatedAt = now
}

func markStepSkipped(step *ExecutionStep, jobs []ExecutionJob, now time.Time) {
	applyStepStatus(step, ExecutionSkipped, now)
	jidx := jobIndexForStep(jobs, step.ID)
	if jidx < 0 {
		return
	}
	switch jobs[jidx].Status {
	case JobBlocked, JobQueued:
		jobs[jidx].Status = JobSkipped
		jobs[jidx].UpdatedAt = now
	}
}

func latestStepIndex(steps []ExecutionStep, nodeID string) int {
	best := -1
	bestAttempt := -1
	for i := range steps {
		if steps[i].NodeID != nodeID {
			continue
		}
		if steps[i].Attempt >= bestAttempt {
			best = i
			bestAttempt = steps[i].Attempt
		}
	}
	return best
}

func jobIndexForStep(jobs []ExecutionJob, stepID string) int {
	found := -1
	for i := range jobs {
		if jobs[i].ExecutionStepID != stepID {
			continue
		}
		if jobs[i].Status == JobBlocked || jobs[i].Status == JobQueued {
			return i
		}
		found = i
	}
	return found
}
