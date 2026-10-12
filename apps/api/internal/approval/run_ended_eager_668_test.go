package approval

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Gracie's M2 on #669: Memory closes a finished run's pending approval
// eagerly, right after the run-ending rollup drops the workflow lock, so
// no read path sees it as pending and gates_ended carries the real count
// and the rollup's time.
func TestMemoryRunEndedClosesEagerly668(t *testing.T) {
	var wfMem *wfstore.Memory
	var apMem *Memory
	h := &runEndedHarness{t: t, ctx: context.Background(), memory: true}
	h.fresh = func(int64) (wfstore.Store, Store, isolation.Scope, isolation.Scope) {
		wfMem = wfstore.NewMemory()
		apMem = NewMemory()
		apMem.SetGateWaiting(wfMem.ApprovalGateWaiting)
		apMem.SetRunEnded(wfMem.RunEndedForApprovals)
		wfMem.SetApprovalPending(apMem.PendingExpiry)
		wfMem.SetApprovalRunEnded(apMem.CloseRunEnded)
		owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
		if err != nil {
			t.Fatal(err)
		}
		approver, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "55555555-5555-4555-8555-555555555555")
		if err != nil {
			t.Fatal(err)
		}
		return wfMem, apMem, owner, approver
	}
	run := h.start()
	if !apMem.HasPending(run.exec.ID, "gate") {
		t.Fatal("gate not pending before the run ended")
	}
	endedAt := h.base.Add(2 * time.Minute)
	if err := h.recover(); err != nil {
		t.Fatal(err)
	}

	// Inspect the row before any read path could close it lazily.
	apMem.mu.Lock()
	row := apMem.rows[run.rec.ID].record
	apMem.mu.Unlock()
	if row.Status != StatusCanceled || row.CloseReason != ReasonRunEnded || !row.UpdatedAt.Equal(endedAt) {
		t.Fatalf("row after rollup = %s %q at %s, want canceled run_ended at %s", row.Status, row.CloseReason, row.UpdatedAt, endedAt)
	}
	if apMem.HasPending(run.exec.ID, "gate") {
		t.Fatal("HasPending still true after the run ended")
	}
	if _, ok := apMem.PendingExpiry(run.exec.ID, "gate"); ok {
		t.Fatal("PendingExpiry still reports a pending approval")
	}
	events, err := apMem.Events(h.ctx, h.scope, run.rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	canceled := 0
	for _, ev := range events {
		if ev.EventType == EventCanceled && fmt.Sprint(ev.Details["reason"]) == ReasonRunEnded {
			canceled++
		}
	}
	if canceled != 1 {
		t.Fatalf("canceled run_ended events = %d, want 1: %+v", canceled, events)
	}
	// List (which feeds TargetsCaller) and Get see the closed row too.
	if items, err := apMem.List(h.ctx, h.scope, Filter{Status: StatusPending, ExecutionID: run.exec.ID}); err != nil || len(items) != 0 {
		t.Fatalf("pending list = %d %v", len(items), err)
	}

	audits, err := wfMem.ListAuditEvents(h.ctx, h.scope, wfstore.AuditListFilter{Action: wfstore.ActionGatesEnded, ResourceID: run.exec.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 1 {
		t.Fatalf("gates_ended rows = %d, want 1", len(audits))
	}
	a := audits[0]
	if fmt.Sprint(a.Details["approvalsClosed"]) != "1" || fmt.Sprint(a.Details["gates"]) != "1" || !a.OccurredAt.Equal(endedAt) {
		t.Fatalf("gates_ended = %+v at %s, want approvalsClosed 1, gates 1 at %s", a.Details, a.OccurredAt, endedAt)
	}

	// A second rollup tick closes nothing more and writes no new row.
	if _, err := wfMem.RecoverExpiredLeases(h.ctx, h.scope, endedAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if audits, _ := wfMem.ListAuditEvents(h.ctx, h.scope, wfstore.AuditListFilter{Action: wfstore.ActionGatesEnded, ResourceID: run.exec.ID}); len(audits) != 1 {
		t.Fatalf("gates_ended rows after a second tick = %d", len(audits))
	}
}
