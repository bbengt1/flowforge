package e12resilience

import "testing"

func TestReportEvaluateRequiresTwoX(t *testing.T) {
	t.Parallel()
	ok := Report{
		Peaks: Peaks{DBConnections: 3, DBWritesPerSec: 40, QueueLagSeconds: 1, QueueDepth: 16, StorageGrowthBytes: 1000},
		Capacity: Capacity{
			DBConnections: 8, DBWritesPerSec: 200, QueueLagSecondsSLO: 15,
			QueueDepthBudget: 64, StorageBudgetBytes: 1 << 30,
		},
		WorkerLoss: WorkerLossProof{Recovered: 1, BecameIndeterminate: true, StaleCompleteRejected: true},
	}.evaluate()
	if !ok.OK {
		t.Fatalf("expected pass: %v", ok.Failures)
	}
	if ok.Headroom["dbConnections"] < MinHeadroom {
		t.Fatalf("connections headroom %v", ok.Headroom["dbConnections"])
	}

	bad := ok
	bad.Peaks.DBConnections = 5
	bad = bad.evaluate()
	if bad.OK {
		t.Fatal("5 connections vs pool 8 must fail 2×")
	}
}
