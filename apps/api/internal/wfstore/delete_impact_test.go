package wfstore

import "testing"

func TestClassifyDeleteRuns(t *testing.T) {
	waiting := openRun{
		id:     "parked",
		status: ExecutionWaiting,
		jobs:   []ExecutionJob{{Status: JobWaiting}, {Status: JobBlocked}},
		steps:  []ExecutionStep{{Status: ExecutionWaiting}, {Status: ExecutionPending}},
	}
	queued := openRun{
		id:     "queued",
		status: ExecutionQueued,
		jobs:   []ExecutionJob{{Status: JobQueued}},
		steps:  []ExecutionStep{{Status: ExecutionQueued}},
	}
	sibling := openRun{
		id:     "sibling",
		status: ExecutionWaiting,
		jobs:   []ExecutionJob{{Status: JobWaiting}, {Status: JobRunning}},
		steps:  []ExecutionStep{{Status: ExecutionWaiting}, {Status: ExecutionRunning}},
	}
	finished := openRun{
		id:     "finished-active",
		status: ExecutionRunning,
		jobs:   []ExecutionJob{{Status: JobSucceeded}, {Status: JobSkipped}},
		steps:  []ExecutionStep{{Status: ExecutionSucceeded}, {Status: ExecutionSkipped}},
	}
	done := openRun{
		id:     "done",
		status: ExecutionSucceeded,
		jobs:   []ExecutionJob{{Status: JobSucceeded}},
	}

	impact, parked, rollup := classifyDeleteRuns([]openRun{waiting, done})
	if impact.Blocked || impact.InFlightRuns != 0 || impact.WaitingRuns != 1 || len(parked) != 1 || parked[0] != "parked" || len(rollup) != 0 {
		t.Fatalf("parked impact = %+v ids=%v rollup=%v", impact, parked, rollup)
	}

	impact, parked, rollup = classifyDeleteRuns([]openRun{sibling, queued})
	if !impact.Blocked || impact.InFlightRuns != 2 || impact.WaitingRuns != 0 || len(parked) != 0 || len(rollup) != 0 {
		t.Fatalf("in-flight impact = %+v ids=%v rollup=%v", impact, parked, rollup)
	}

	impact, parked, rollup = classifyDeleteRuns([]openRun{finished})
	if impact.Blocked || impact.InFlightRuns != 0 || impact.WaitingRuns != 0 || len(parked) != 0 || len(rollup) != 1 || rollup[0] != "finished-active" {
		t.Fatalf("finished-but-active impact = %+v ids=%v rollup=%v", impact, parked, rollup)
	}
}
