package wfstore

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.1: item model storage and paged reads.

// Item cap failure codes. Breaking a cap fails the step with one of these
// codes; item rows are never truncated.
const (
	ItemCodeTooLarge            = "item-too-large"
	ItemCodeCapExceeded         = "item-cap-exceeded"
	ItemCodeStepBudgetExceeded  = "step-budget-exceeded"
	ItemCodeRunBudgetExceeded   = "run-budget-exceeded"
	ActionStepItemsCompleted    = "step.items_completed"
	maxItemPortLen              = 128
	maxItemLineageRefs          = workflow.MaxAggregationItems
	maxItemSummaryPreviewBudget = 12 * 1024
)

// ItemCapError is a cap breach. Code is one of the ItemCode constants. The
// message never carries item values.
type ItemCapError struct {
	Code string
}

func (e *ItemCapError) Error() string { return e.Code }

// ItemCapCode returns the cap code wrapped in err, or "".
func ItemCapCode(err error) string {
	var ce *ItemCapError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return ""
}

// ItemRef is one engine-assigned lineage source. StepID is the
// execution_steps uuid (exact attempt); NodeID is the YAML node id.
type ItemRef struct {
	StepID string `json:"stepId"`
	NodeID string `json:"nodeId"`
	Port   string `json:"port"`
	Idx    int    `json:"idx"`
}

// PortItems is the list written to one items port of a step. Sources, when
// set, has one entry per item and is assigned by the engine, never by node
// output.
type PortItems struct {
	Port    string
	Items   []map[string]any
	Sources [][]ItemRef
}

// PutStepItemsInput writes every items port of one step in one
// transaction. A step's items are written once.
type PutStepItemsInput struct {
	ExecutionID string
	StepID      string
	Ports       []PortItems
}

// PutStepItemsResult is the counts-only outcome.
type PutStepItemsResult struct {
	Count int   `json:"count"`
	Bytes int64 `json:"bytes"`
}

// StepItem is one redacted item as returned by the items API.
type StepItem struct {
	Idx     int            `json:"idx"`
	Item    map[string]any `json:"item"`
	Lineage map[string]any `json:"lineage"`
}

// StepItemsQuery is a page request. AfterIdx is -1 for the first page.
type StepItemsQuery struct {
	ExecutionID string
	StepID      string
	Port        string
	AfterIdx    int
	Limit       int
}

// StepItemsPage is one page. Total comes from the step summary's count,
// not COUNT(*). Next is the last idx returned when more rows follow, or -1.
type StepItemsPage struct {
	Items []StepItem
	Total int
	Next  int
}

// ItemStore is implemented by both workflow stores.
type ItemStore interface {
	PutStepItems(ctx context.Context, scope isolation.Scope, in PutStepItemsInput) (PutStepItemsResult, error)
	ListStepItems(ctx context.Context, scope isolation.Scope, q StepItemsQuery) (StepItemsPage, error)
}

type preparedItem struct {
	port    string
	idx     int
	value   map[string]any
	raw     []byte
	lineage map[string]any
	linRaw  []byte
}

type preparedPort struct {
	port  string
	items []preparedItem
	bytes int64
}

type preparedItems struct {
	ports []preparedPort
	count int
	bytes int64
}

func validItemPort(port string) bool {
	return port != "" && len(port) <= maxItemPortLen && strings.TrimSpace(port) == port
}

// prepareItems validates shape, redacts each item before anything is
// persisted, measures bytes after redaction, and enforces the item, port,
// and step caps. It never truncates.
func prepareItems(in PutStepItemsInput) (preparedItems, error) {
	var out preparedItems
	if !authz.ValidUUID(in.ExecutionID) || !authz.ValidUUID(in.StepID) || len(in.Ports) == 0 {
		return out, ErrInvalid
	}
	seen := map[string]struct{}{}
	for _, p := range in.Ports {
		if !validItemPort(p.Port) {
			return out, ErrInvalid
		}
		if _, dup := seen[p.Port]; dup {
			return out, ErrInvalid
		}
		seen[p.Port] = struct{}{}
		if p.Sources != nil && len(p.Sources) != len(p.Items) {
			return out, ErrInvalid
		}
		if len(p.Items) > workflow.MaxItemsPerPort {
			return out, &ItemCapError{Code: ItemCodeCapExceeded}
		}
		pp := preparedPort{port: p.Port}
		for i, item := range p.Items {
			if item == nil {
				return out, ErrInvalid
			}
			red, ok := RedactValue(item).(map[string]any)
			if !ok {
				return out, ErrInvalid
			}
			raw, err := json.Marshal(red)
			if err != nil {
				return out, ErrInvalid
			}
			if len(raw) > workflow.MaxItemBytes {
				return out, &ItemCapError{Code: ItemCodeTooLarge}
			}
			var refs []ItemRef
			if p.Sources != nil {
				refs = p.Sources[i]
			}
			lin, err := buildLineage(i, refs)
			if err != nil {
				return out, err
			}
			linRaw, err := json.Marshal(lin)
			if err != nil {
				return out, ErrInvalid
			}
			pp.items = append(pp.items, preparedItem{port: p.Port, idx: i, value: red, raw: raw, lineage: lin, linRaw: linRaw})
			pp.bytes += int64(len(raw))
			out.bytes += int64(len(raw))
			out.count++
			if out.bytes > workflow.MaxStepItemBytes {
				return out, &ItemCapError{Code: ItemCodeStepBudgetExceeded}
			}
		}
		out.ports = append(out.ports, pp)
	}
	sort.Slice(out.ports, func(i, j int) bool { return out.ports[i].port < out.ports[j].port })
	return out, nil
}

// buildLineage assigns {idx, src:[...]} server-side. More than 32 refs are
// cut to 32 and flagged truncated:true.
func buildLineage(idx int, refs []ItemRef) (map[string]any, error) {
	src := make([]any, 0, len(refs))
	truncated := false
	for i, r := range refs {
		if !authz.ValidUUID(r.StepID) || r.NodeID == "" || len(r.NodeID) > 128 || !validItemPort(r.Port) || r.Idx < 0 || r.Idx >= workflow.MaxItemsPerPort {
			return nil, ErrInvalid
		}
		if i >= maxItemLineageRefs {
			truncated = true
			break
		}
		src = append(src, map[string]any{"stepId": r.StepID, "nodeId": r.NodeID, "port": r.Port, "idx": r.Idx})
	}
	lin := map[string]any{"idx": idx, "src": src}
	if truncated {
		lin["truncated"] = true
	}
	return lin, nil
}

// buildItemsOutput merges the bounded, flagged summary into a step's
// redacted output under "items": {<port>: {port, count, bytes, truncated,
// preview}}. The whole serialized output stays within MaxStepOutputBytes,
// so BoundStep and the edge SQL (000035, output_redacted->>'port') are
// unchanged. count and bytes are exact; preview items are added in idx
// order only while the total stays in bound.
func buildItemsOutput(existing map[string]any, prep preparedItems) map[string]any {
	out := cloneObject(existing)
	if out == nil {
		out = map[string]any{}
	}
	summaries := map[string]any{}
	type entry struct {
		port    string
		summary map[string]any
		preview []any
		items   []preparedItem
	}
	entries := make([]*entry, 0, len(prep.ports))
	for _, p := range prep.ports {
		e := &entry{port: p.port, items: p.items, preview: []any{}}
		e.summary = map[string]any{
			"port":      p.port,
			"count":     len(p.items),
			"bytes":     p.bytes,
			"truncated": len(p.items) > 0,
			"preview":   e.preview,
		}
		summaries[p.port] = e.summary
		entries = append(entries, e)
	}
	out["items"] = summaries
	size := func() int {
		raw, err := json.Marshal(out)
		if err != nil {
			return MaxStepOutputBytes + 1
		}
		return len(raw)
	}
	if size() > MaxStepOutputBytes {
		// The envelope alone does not fit (many ports, or a large
		// pre-existing output). Drop the existing payload; counts stay.
		out = map[string]any{"items": summaries}
		if p, ok := existing["port"].(string); ok {
			out["port"] = p
		}
	}
	previewBytes := 0
	for _, e := range entries {
		for _, it := range e.items {
			if previewBytes+len(it.raw) > maxItemSummaryPreviewBudget {
				break
			}
			e.preview = append(e.preview, it.value)
			e.summary["preview"] = e.preview
			if size() > MaxStepOutputBytes {
				e.preview = e.preview[:len(e.preview)-1]
				e.summary["preview"] = e.preview
				break
			}
			previewBytes += len(it.raw)
		}
		e.summary["truncated"] = len(e.preview) < len(e.items)
	}
	return out
}

// itemsSummaryCount reads summary.count for port. ok is false when the
// step has no items summary for that port.
func itemsSummaryCount(output map[string]any, port string) (int, bool) {
	items, _ := output["items"].(map[string]any)
	sum, _ := items[port].(map[string]any)
	if sum == nil {
		return 0, false
	}
	switch n := sum["count"].(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case json.Number:
		v, err := n.Int64()
		return int(v), err == nil
	}
	return 0, false
}

func stepHasItems(output map[string]any) bool {
	items, _ := output["items"].(map[string]any)
	return len(items) > 0
}

// singleItemPage is the back-compat read: a step without an items summary
// for port exposes its existing port value as a one-item list. A missing
// or non-object value is an empty list.
func singleItemPage(step ExecutionStep, q StepItemsQuery) StepItemsPage {
	v, ok := step.Output[q.Port].(map[string]any)
	if !ok {
		return StepItemsPage{Items: []StepItem{}, Total: 0, Next: -1}
	}
	page := StepItemsPage{Items: []StepItem{}, Total: 1, Next: -1}
	if q.AfterIdx < 0 {
		bounded, _ := boundObject(v, workflow.MaxItemBytes)
		page.Items = append(page.Items, StepItem{
			Idx:     0,
			Item:    bounded,
			Lineage: map[string]any{"idx": 0, "src": []any{}},
		})
	}
	return page
}

func normalizeItemsQuery(q StepItemsQuery) (StepItemsQuery, error) {
	if !authz.ValidUUID(q.ExecutionID) || !authz.ValidUUID(q.StepID) {
		return q, ErrNotFound
	}
	if !validItemPort(q.Port) || q.AfterIdx < -1 || q.AfterIdx >= workflow.MaxItemsPerPort {
		return q, ErrInvalid
	}
	q.Limit = listLimit(q.Limit)
	return q, nil
}
