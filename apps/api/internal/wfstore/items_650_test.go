package wfstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.1: item storage, caps, summary, paging, audit, retention. The
// suite runs on both stores (T1 store half, T8, T9 cap parts, T11, T12).

const itemsYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: items
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: a
      type: data.set
      name: A
      with:
        value:
          seen: true
    - id: b
      type: flow.stop
      name: B
      with:
        status: success
  edges:
    - from: a.result
      to: b.input
`

type itemsHarness struct {
	t     *testing.T
	ctx   context.Context
	store Store
	items ItemStore
	scope isolation.Scope
	// other is a scope in a different workspace.
	other isolation.Scope
	// presetRunBytes sets the run's item budget counter directly.
	presetRunBytes func(executionID string, n int64)
	// setOutputFn replaces a step's redacted output (legacy single-object shape).
	setOutputFn func(executionID, stepID string, out map[string]any)
	// expire moves the run's retention_until into the past.
	expire func(executionID string)
	// countItemRows counts rows bypassing RLS (Postgres only).
	countItemRows func(stepID string) int
}

func (h itemsHarness) setOutput(exec Execution, step ExecutionStep, out map[string]any) {
	h.setOutputFn(exec.ID, step.ID, out)
}

func (h itemsHarness) start() (Execution, map[string]ExecutionStep) {
	h.t.Helper()
	src := strings.Replace(itemsYAML, "\n  name: ", "\n  name: i"+strconv.FormatInt(time.Now().UnixNano(), 36)+"-", 1)
	n := mustNormalize(h.t, src)
	wf, draft, err := h.store.Create(h.ctx, h.scope, CreateInput{NormalizedYAML: n.NormalizedYAML, Digest: n.Digest, Summary: n.Summary})
	if err != nil {
		h.t.Fatal(err)
	}
	_, ver, err := h.store.Publish(h.ctx, h.scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		h.t.Fatal(err)
	}
	exec, err := h.store.StartExecution(h.ctx, h.scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		h.t.Fatal(err)
	}
	steps, err := h.store.ListSteps(h.ctx, h.scope, exec.ID)
	if err != nil {
		h.t.Fatal(err)
	}
	byNode := map[string]ExecutionStep{}
	for _, s := range steps {
		byNode[s.NodeID] = s
	}
	if len(byNode) != 2 {
		h.t.Fatalf("steps = %d", len(byNode))
	}
	return exec, byNode
}

func makeItems(n, pad int) []map[string]any {
	out := make([]map[string]any, n)
	for i := range out {
		out[i] = map[string]any{"n": i, "pad": strings.Repeat("x", pad)}
	}
	return out
}

func (h itemsHarness) put(exec Execution, step ExecutionStep, ports ...PortItems) (PutStepItemsResult, error) {
	return h.items.PutStepItems(h.ctx, h.scope, PutStepItemsInput{ExecutionID: exec.ID, StepID: step.ID, Ports: ports})
}

func (h itemsHarness) list(exec Execution, step ExecutionStep, port string, after, limit int) StepItemsPage {
	h.t.Helper()
	page, err := h.items.ListStepItems(h.ctx, h.scope, StepItemsQuery{ExecutionID: exec.ID, StepID: step.ID, Port: port, AfterIdx: after, Limit: limit})
	if err != nil {
		h.t.Fatal(err)
	}
	return page
}

func (h itemsHarness) itemAudits(execID string) []AuditEvent {
	h.t.Helper()
	got, err := h.store.ListAuditEvents(h.ctx, h.scope, AuditListFilter{Action: ActionStepItemsCompleted, ResourceID: execID})
	if err != nil {
		h.t.Fatal(err)
	}
	return got
}

func (h itemsHarness) stepOutput(exec Execution, step ExecutionStep) map[string]any {
	h.t.Helper()
	got, err := h.store.GetStep(h.ctx, h.scope, exec.ID, step.ID)
	if err != nil {
		h.t.Fatal(err)
	}
	return got.Output
}

func wantCap(t *testing.T, err error, code string) {
	t.Helper()
	if ItemCapCode(err) != code {
		t.Fatalf("err = %v, want %s", err, code)
	}
}

func runItemsSuite(t *testing.T, newH func(t *testing.T) itemsHarness) {
	t.Run("T9 item_too_large_fails", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		_, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(1, workflow.MaxItemBytes)})
		wantCap(t, err, ItemCodeTooLarge)
	})
	t.Run("T9 port_cap_enforced", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		_, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(workflow.MaxItemsPerPort+1, 0)})
		wantCap(t, err, ItemCodeCapExceeded)
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(workflow.MaxItemsPerPort, 0)}); err != nil {
			t.Fatalf("exactly %d items: %v", workflow.MaxItemsPerPort, err)
		}
	})
	t.Run("T9 step_budget_enforced", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		// 300 items of ~15 KiB across two ports > 4 MiB, each item and port in cap.
		_, err := h.put(exec, steps["a"],
			PortItems{Port: "left", Items: makeItems(150, 15000)},
			PortItems{Port: "right", Items: makeItems(150, 15000)})
		wantCap(t, err, ItemCodeStepBudgetExceeded)
	})
	t.Run("T9 run_item_budget concurrent steps cannot pass 64 MiB", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		one := makeItems(1, 100)
		raw, _ := json.Marshal(one[0])
		// Leave room for exactly one of the two steps.
		h.presetRunBytes(exec.ID, int64(workflow.MaxRunItemBytes)-int64(len(raw))-int64(len(raw))/2)
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i, node := range []string{"a", "b"} {
			wg.Add(1)
			go func(i int, step ExecutionStep) {
				defer wg.Done()
				_, errs[i] = h.put(exec, step, PortItems{Port: "main", Items: makeItems(1, 100)})
			}(i, steps[node])
		}
		wg.Wait()
		ok, over := 0, 0
		for _, err := range errs {
			switch {
			case err == nil:
				ok++
			case ItemCapCode(err) == ItemCodeRunBudgetExceeded:
				over++
			default:
				t.Fatalf("unexpected: %v", err)
			}
		}
		if ok != 1 || over != 1 {
			t.Fatalf("ok=%d over=%d", ok, over)
		}
		if n := len(h.itemAudits(exec.ID)); n != 1 {
			t.Fatalf("audits = %d", n)
		}
	})
	t.Run("T8 audit_same_tx_items rollback leaves neither row nor audit", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		h.presetRunBytes(exec.ID, int64(workflow.MaxRunItemBytes))
		_, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(3, 10)})
		wantCap(t, err, ItemCodeRunBudgetExceeded)
		if n := len(h.itemAudits(exec.ID)); n != 0 {
			t.Fatalf("audits = %d", n)
		}
		if out := h.stepOutput(exec, steps["a"]); out[ItemsSummaryKey] != nil {
			t.Fatalf("summary written: %v", out)
		}
		if page := h.list(exec, steps["a"], "main", -1, 0); len(page.Items) != 0 || page.Total != 0 {
			t.Fatalf("rows written: %+v", page)
		}
	})
	t.Run("T8 audit_counts_match_items", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		res, err := h.put(exec, steps["a"],
			PortItems{Port: "main", Items: makeItems(7, 20)},
			PortItems{Port: "extra", Items: makeItems(2, 20)})
		if err != nil {
			t.Fatal(err)
		}
		audits := h.itemAudits(exec.ID)
		if len(audits) != 1 {
			t.Fatalf("audits = %d", len(audits))
		}
		d := audits[0].Details
		if num(d["count"]) != 9 || num(d["count"]) != res.Count || int64(num(d["bytes"])) != res.Bytes || num(d["failed"]) != 0 || num(d["indeterminate"]) != 0 || d["stepId"] != steps["a"].ID {
			t.Fatalf("details = %v res = %+v", d, res)
		}
		raw, _ := json.Marshal(audits[0])
		if strings.Contains(string(raw), "xxxxxxxxxx") {
			t.Fatal("audit carries item values")
		}
	})
	t.Run("T11 items_cap_fails_not_truncates", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		items := makeItems(3, 10)
		items[2]["pad"] = strings.Repeat("y", workflow.MaxItemBytes)
		_, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: items})
		wantCap(t, err, ItemCodeTooLarge)
		if page := h.list(exec, steps["a"], "main", -1, 0); len(page.Items) != 0 {
			t.Fatalf("partial rows written: %d", len(page.Items))
		}
		// Full-size items round-trip whole.
		big := makeItems(5, workflow.MaxItemBytes-64)
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: big}); err != nil {
			t.Fatal(err)
		}
		page := h.list(exec, steps["a"], "main", -1, 0)
		for _, it := range page.Items {
			if len(it.Item["pad"].(string)) != workflow.MaxItemBytes-64 {
				t.Fatalf("item %d truncated", it.Idx)
			}
		}
	})
	t.Run("T11 summary_bounded_and_flagged", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		before := h.stepOutput(exec, steps["a"])
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(200, 500)}); err != nil {
			t.Fatal(err)
		}
		out := h.stepOutput(exec, steps["a"])
		raw, _ := json.Marshal(out)
		if len(raw) > MaxStepOutputBytes {
			t.Fatalf("summary %d bytes", len(raw))
		}
		sum := out[ItemsSummaryKey].(map[string]any)["main"].(map[string]any)
		if sum["truncated"] != true || num(sum["count"]) != 200 || sum["port"] != "main" {
			t.Fatalf("summary = %v", sum["count"])
		}
		if prev := sum["preview"].([]any); len(prev) == 0 || len(prev) >= 200 {
			t.Fatalf("preview = %d", len(prev))
		}
		// Edge SQL reads output_redacted->>'port'; items must not change it.
		if out["port"] != before["port"] {
			t.Fatalf("port changed: %v -> %v", before["port"], out["port"])
		}
		step, _ := h.store.GetStep(h.ctx, h.scope, exec.ID, steps["a"].ID)
		if BoundStep(step).OutputTruncated {
			t.Fatal("BoundStep truncated the summary")
		}
		// A small list fits whole and is not flagged.
		exec2, steps2 := h.start()
		if _, err := h.put(exec2, steps2["a"], PortItems{Port: "main", Items: makeItems(3, 5)}); err != nil {
			t.Fatal(err)
		}
		sum2 := h.stepOutput(exec2, steps2["a"])[ItemsSummaryKey].(map[string]any)["main"].(map[string]any)
		if sum2["truncated"] != false || len(sum2["preview"].([]any)) != 3 {
			t.Fatalf("small summary = %v", sum2)
		}
	})
	t.Run("T11 single_item_backcompat", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		h.setOutput(exec, steps["a"], map[string]any{"result": map[string]any{"env": "staging"}})
		page := h.list(exec, steps["a"], "result", -1, 0)
		if page.Total != 1 || len(page.Items) != 1 || page.Items[0].Item["env"] != "staging" || page.Items[0].Idx != 0 {
			t.Fatalf("page = %+v", page)
		}
		if page := h.list(exec, steps["a"], "missing", -1, 0); page.Total != 0 || len(page.Items) != 0 {
			t.Fatalf("missing = %+v", page)
		}
	})
	t.Run("T11 max_items_ports_per_step", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		ports := make([]PortItems, MaxItemPortsPerStep+1)
		for i := range ports {
			ports[i] = PortItems{Port: "p" + strconv.Itoa(i), Items: makeItems(1, 5)}
		}
		_, err := h.put(exec, steps["a"], ports...)
		wantCap(t, err, ItemCodeCapExceeded)
		// Exactly 16 ports with large previews still fits the bound.
		ports = ports[:MaxItemPortsPerStep]
		for i := range ports {
			ports[i].Items = makeItems(20, 900)
		}
		if _, err := h.put(exec, steps["a"], ports...); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(h.stepOutput(exec, steps["a"]))
		if len(raw) > MaxStepOutputBytes {
			t.Fatalf("summary %d bytes > %d", len(raw), MaxStepOutputBytes)
		}
	})
	t.Run("L2 summary_overflow_fails_with_cap_code", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		h.setOutput(exec, steps["a"], map[string]any{"result": map[string]any{"blob": strings.Repeat("z", MaxStepOutputBytes-200)}})
		ports := make([]PortItems, MaxItemPortsPerStep)
		for i := range ports {
			ports[i] = PortItems{Port: "port-" + strconv.Itoa(i), Items: makeItems(1, 5)}
		}
		_, err := h.put(exec, steps["a"], ports...)
		wantCap(t, err, ItemCodeSummaryTooLarge)
		out := h.stepOutput(exec, steps["a"])
		if out[ItemsSummaryKey] != nil || len(out["result"].(map[string]any)["blob"].(string)) != MaxStepOutputBytes-200 {
			t.Fatal("output dropped or summary written on overflow")
		}
		if page := h.list(exec, steps["a"], "port-0", -1, 0); page.Total != 0 || len(page.Items) != 0 {
			t.Fatalf("rows written on overflow: %+v", page)
		}
		// Not marked written: a fitting retry succeeds.
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(1, 5)}); err != nil {
			t.Fatalf("retry after overflow: %v", err)
		}
	})
	t.Run("M2 node_items_field_kept", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		own := map[string]any{"items": map[string]any{"sku": "A-1"}, "result": map[string]any{"ok": true}}
		h.setOutput(exec, steps["a"], own)
		// Legacy read of the node's own "items" field before any write.
		if page := h.list(exec, steps["a"], "items", -1, 0); page.Total != 1 || page.Items[0].Item["sku"] != "A-1" {
			t.Fatalf("legacy items read = %+v", page)
		}
		// No false 409.
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(2, 5)}); err != nil {
			t.Fatalf("false conflict: %v", err)
		}
		out := h.stepOutput(exec, steps["a"])
		if got, _ := out["items"].(map[string]any); got["sku"] != "A-1" {
			t.Fatalf("node items field overwritten: %v", out["items"])
		}
		if page := h.list(exec, steps["a"], "items", -1, 0); page.Total != 1 || page.Items[0].Item["sku"] != "A-1" {
			t.Fatalf("legacy items read after write = %+v", page)
		}
		if page := h.list(exec, steps["a"], "main", -1, 0); page.Total != 2 {
			t.Fatalf("main = %+v", page)
		}
		// Write-once comes from items_written_at, not output keys.
		if _, err := h.put(exec, steps["a"], PortItems{Port: "other", Items: makeItems(1, 5)}); !errors.Is(err, ErrConflict) {
			t.Fatalf("second write: %v", err)
		}
	})
	t.Run("M2 job_result_reserved_key_refused", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		now := time.Now().UTC()
		claim, err := h.store.ClaimJob(h.ctx, h.scope, now, ClaimInput{WorkerID: "w", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		bad := map[string]any{"result": map[string]any{"ok": true}, ItemsSummaryKey: map[string]any{"main": map[string]any{"count": 999}}}
		_, err = h.store.CompleteJob(h.ctx, h.scope, now, JobActionInput{JobID: claim.Job.ID, WorkerID: "w", FencingToken: claim.Job.FencingToken, Output: bad})
		if !errors.Is(err, ErrReservedOutputKey) || !errors.Is(err, ErrInvalid) {
			t.Fatalf("reserved key: %v", err)
		}
		out := h.stepOutput(exec, steps["a"])
		if out[ItemsSummaryKey] != nil {
			t.Fatal("reserved key reached output_redacted")
		}
		if page := h.list(exec, steps["a"], "main", -1, 0); page.Total != 0 {
			t.Fatalf("forged summary visible: %+v", page)
		}
		// The fence is intact: a clean completion still succeeds.
		if _, err := h.store.CompleteJob(h.ctx, h.scope, now, JobActionInput{JobID: claim.Job.ID, WorkerID: "w", FencingToken: claim.Job.FencingToken, Output: map[string]any{"result": map[string]any{"ok": true}}}); err != nil {
			t.Fatalf("clean complete: %v", err)
		}
		if h.stepOutput(exec, steps["a"])[ItemsSummaryKey] != nil {
			t.Fatal("reserved key present after completion")
		}
	})
	t.Run("L4 item_values_never_logged", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		var buf bytes.Buffer
		prevSlog := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
		prevOut := log.Writer()
		log.SetOutput(&buf)
		defer func() { slog.SetDefault(prevSlog); log.SetOutput(prevOut) }()
		const marker = "ITEM-VALUE-MARKER-7f3a"
		items := []map[string]any{{"v": marker}, {"v": marker + strings.Repeat("q", workflow.MaxItemBytes)}}
		_, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: items})
		if err == nil || strings.Contains(err.Error(), marker) {
			t.Fatalf("cap error = %v", err)
		}
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: items[:1]}); err != nil {
			t.Fatal(err)
		}
		_ = h.list(exec, steps["a"], "main", -1, 0)
		for _, a := range h.itemAudits(exec.ID) {
			raw, _ := json.Marshal(a)
			if strings.Contains(string(raw), marker) {
				t.Fatal("item value in audit")
			}
		}
		if strings.Contains(buf.String(), marker) {
			t.Fatalf("item value logged: %s", buf.String())
		}
	})
	t.Run("items_redacted_before_persist", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		items := []map[string]any{{"user": "ada", "password": "hunter2-value", "nested": map[string]any{"apiKey": "k-123"}}}
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: items}); err != nil {
			t.Fatal(err)
		}
		page := h.list(exec, steps["a"], "main", -1, 0)
		raw, _ := json.Marshal(page)
		out, _ := json.Marshal(h.stepOutput(exec, steps["a"]))
		for _, s := range []string{string(raw), string(out)} {
			if strings.Contains(s, "hunter2-value") || strings.Contains(s, "k-123") {
				t.Fatalf("secret persisted: %s", s)
			}
		}
		if page.Items[0].Item["user"] != "ada" {
			t.Fatal("non-secret field lost")
		}
	})
	t.Run("paging limit_capped_100 total_from_summary lineage", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		srcStep := steps["b"]
		sources := make([][]ItemRef, 250)
		for i := range sources {
			sources[i] = []ItemRef{{StepID: srcStep.ID, NodeID: "b", Port: "main", Idx: i}}
		}
		sources[0] = make([]ItemRef, 40)
		for i := range sources[0] {
			sources[0][i] = ItemRef{StepID: srcStep.ID, NodeID: "b", Port: "main", Idx: i}
		}
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(250, 1), Sources: sources}); err != nil {
			t.Fatal(err)
		}
		page := h.list(exec, steps["a"], "main", -1, 1000)
		if len(page.Items) != MaxListLimit || page.Total != 250 || page.Next != 99 {
			t.Fatalf("first page = %d total=%d next=%d", len(page.Items), page.Total, page.Next)
		}
		lin := page.Items[0].Lineage
		if lin["truncated"] != true || len(lin["src"].([]any)) != workflow.MaxAggregationItems {
			t.Fatalf("lineage = %v", lin)
		}
		ref := page.Items[1].Lineage["src"].([]any)[0].(map[string]any)
		if ref["stepId"] != srcStep.ID || ref["nodeId"] != "b" {
			t.Fatalf("ref = %v", ref)
		}
		seen := 0
		after := -1
		for {
			p := h.list(exec, steps["a"], "main", after, 100)
			for _, it := range p.Items {
				if it.Idx != seen {
					t.Fatalf("idx %d want %d", it.Idx, seen)
				}
				seen++
			}
			if p.Next < 0 {
				break
			}
			after = p.Next
		}
		if seen != 250 {
			t.Fatalf("seen = %d", seen)
		}
	})
	t.Run("write once and malformed input", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(1, 1)}); err != nil {
			t.Fatal(err)
		}
		if _, err := h.put(exec, steps["a"], PortItems{Port: "other", Items: makeItems(1, 1)}); !errors.Is(err, ErrConflict) {
			t.Fatalf("second write: %v", err)
		}
		for _, bad := range []PortItems{
			{Port: "", Items: makeItems(1, 1)},
			{Port: strings.Repeat("p", 129), Items: makeItems(1, 1)},
			{Port: "main", Items: []map[string]any{nil}},
			{Port: "main", Items: makeItems(2, 1), Sources: [][]ItemRef{{}}},
			{Port: "main", Items: makeItems(1, 1), Sources: [][]ItemRef{{{StepID: "nope", NodeID: "b", Port: "main"}}}},
		} {
			if _, err := h.put(exec, steps["b"], bad); !errors.Is(err, ErrInvalid) {
				t.Fatalf("bad %q: %v", bad.Port, err)
			}
		}
	})
	t.Run("T1 cross-workspace read and write are not found", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(2, 1)}); err != nil {
			t.Fatal(err)
		}
		if _, err := h.items.ListStepItems(h.ctx, h.other, StepItemsQuery{ExecutionID: exec.ID, StepID: steps["a"].ID, Port: "main", AfterIdx: -1}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross read: %v", err)
		}
		if _, err := h.items.PutStepItems(h.ctx, h.other, PutStepItemsInput{ExecutionID: exec.ID, StepID: steps["b"].ID, Ports: []PortItems{{Port: "main", Items: makeItems(1, 1)}}}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross write: %v", err)
		}
		// A step of another execution is not found through this execution.
		exec2, _ := h.start()
		if _, err := h.items.ListStepItems(h.ctx, h.scope, StepItemsQuery{ExecutionID: exec2.ID, StepID: steps["a"].ID, Port: "main", AfterIdx: -1}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross run: %v", err)
		}
	})
	t.Run("T12 items_purge_cascade", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(3, 1)}); err != nil {
			t.Fatal(err)
		}
		h.expire(exec.ID)
		if _, _, err := h.store.PurgeExpired(h.ctx, h.scope, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		if _, err := h.items.ListStepItems(h.ctx, h.scope, StepItemsQuery{ExecutionID: exec.ID, StepID: steps["a"].ID, Port: "main", AfterIdx: -1}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("after purge: %v", err)
		}
		if h.countItemRows != nil {
			if n := h.countItemRows(steps["a"].ID); n != 0 {
				t.Fatalf("rows after purge = %d", n)
			}
		}
	})
	t.Run("T12 items_legal_hold_kept", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(3, 1)}); err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		art, err := h.store.CreateArtifact(h.ctx, h.scope, CreateArtifactInput{
			ExecutionID: exec.ID, StepID: steps["a"].ID, Kind: "file", Filename: "note.txt",
			ContentType: "text/plain", ContentClassification: "internal",
			Digest:    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			SizeBytes: 4, Redacted: true, ExpiresAt: now.Add(time.Hour), StorageRef: newID(),
			MetadataCiphertext: []byte("meta"), DEKEnvelope: []byte("dek"), KeyReference: "test", EncryptionVersion: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := h.store.SetLegalHold(h.ctx, h.scope, art.ID, LegalHoldInput{Hold: true, Reason: "case"}); err != nil {
			t.Fatal(err)
		}
		h.expire(exec.ID)
		if _, _, err := h.store.PurgeExpired(h.ctx, h.scope, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		if page := h.list(exec, steps["a"], "main", -1, 0); len(page.Items) != 3 {
			t.Fatalf("held items = %d", len(page.Items))
		}
	})
}

func TestMemoryItems650(t *testing.T) {
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	other, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	runItemsSuite(t, func(t *testing.T) itemsHarness {
		m := NewMemory()
		return itemsHarness{
			t: t, ctx: context.Background(), store: m, items: m, scope: scope, other: other,
			presetRunBytes: func(id string, n int64) {
				m.mu.Lock()
				defer m.mu.Unlock()
				e := m.executions[id]
				e.itemBytes = n
				m.executions[id] = e
			},
			expire: func(id string) {
				m.mu.Lock()
				defer m.mu.Unlock()
				e := m.executions[id]
				e.record.RetentionUntil = time.Now().UTC().Add(-time.Hour)
				m.executions[id] = e
			},
			setOutputFn: func(execID, stepID string, out map[string]any) {
				m.mu.Lock()
				defer m.mu.Unlock()
				e := m.executions[execID]
				for i := range e.steps {
					if e.steps[i].ID == stepID {
						e.steps[i].Output = out
					}
				}
			},
		}
	})
}

func TestPostgresItems650(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	store := NewPostgres(app)
	newH := func(t *testing.T) itemsHarness {
		wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
		scope, _ := isolation.Authorize(wsA, userID)
		other, _ := isolation.Authorize(wsB, userID)
		return itemsHarness{
			t: t, ctx: ctx, store: store, items: store, scope: scope, other: other,
			presetRunBytes: func(id string, n int64) {
				if _, err := admin.Exec(ctx, `UPDATE executions SET item_bytes = $2 WHERE id = $1::uuid`, id, n); err != nil {
					t.Fatal(err)
				}
			},
			expire: func(id string) {
				if _, err := admin.Exec(ctx, `UPDATE executions SET retention_until = now() - interval '1 hour' WHERE id = $1::uuid`, id); err != nil {
					t.Fatal(err)
				}
			},
			setOutputFn: func(execID, stepID string, out map[string]any) {
				raw, _ := json.Marshal(out)
				if _, err := admin.Exec(ctx, `UPDATE execution_steps SET output_redacted = $3::jsonb WHERE execution_id = $1::uuid AND id = $2::uuid`, execID, stepID, raw); err != nil {
					t.Fatal(err)
				}
			},
			countItemRows: func(stepID string) int {
				var n int
				if err := admin.QueryRow(ctx, `SELECT count(*) FROM execution_step_items WHERE step_id = $1::uuid`, stepID).Scan(&n); err != nil {
					t.Fatal(err)
				}
				return n
			},
		}
	}
	runItemsSuite(t, newH)
	runItemsPostgresOnly(t, ctx, admin, app, newH)
}
