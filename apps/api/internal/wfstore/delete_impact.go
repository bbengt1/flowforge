package wfstore

// DeleteImpact is the read-only picture DELETE uses to decide 409 versus
// stopping parked runs. waitingRuns are the runs delete will fail.
// blocked is true when a non-terminal run still has a job in queued,
// claimed, or running. inFlightRuns counts those runs.
type DeleteImpact struct {
	WaitingRuns  int  `json:"waitingRuns"`
	Blocked      bool `json:"blocked"`
	InFlightRuns int  `json:"inFlightRuns"`
}

type openRun struct {
	id     string
	jobs   []ExecutionJob
	steps  []ExecutionStep
	status string
}

// classifyDeleteRuns is the only delete/block decision. A non-terminal run
// with a queued, claimed, or running job is in flight and blocks delete.
// A run whose unfinished work is only waiting, pending, or blocked does not.
// An in-flight run is not also counted as waiting, even when a sibling
// branch is parked on a gate.
func classifyDeleteRuns(runs []openRun) (DeleteImpact, []string) {
	var impact DeleteImpact
	var parked []string
	for _, run := range runs {
		if isTerminalExecution(run.status) {
			continue
		}
		inFlight, hold := classifyOneRun(run.jobs, run.steps)
		if inFlight {
			impact.InFlightRuns++
			impact.Blocked = true
			continue
		}
		if hold {
			impact.WaitingRuns++
			parked = append(parked, run.id)
		}
	}
	return impact, parked
}

func classifyOneRun(jobs []ExecutionJob, steps []ExecutionStep) (inFlight, parked bool) {
	for _, job := range jobs {
		switch job.Status {
		case JobQueued, JobClaimed, JobRunning:
			inFlight = true
		case JobWaiting, JobBlocked:
			parked = true
		}
	}
	for _, step := range steps {
		switch step.Status {
		case ExecutionWaiting, ExecutionPending:
			parked = true
		}
	}
	if inFlight {
		return true, false
	}
	return false, parked
}
