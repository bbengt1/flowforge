package schedule

import (
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func parseInterval(s string) (time.Duration, error) {
	d, err := workflow.ParseISODuration(s)
	if err != nil || d <= 0 {
		return 0, ErrInvalid
	}
	return d, nil
}

// FirePlan is the dispatcher decision for one due schedule.
type FirePlan struct {
	Fires      []time.Time
	NextFireAt time.Time
	SkipReason string
}

// PlanFires applies safe catch-up and overlap defaults.
// catchUp=0 / misfire=ignore never replays missed slots.
// overlap=skip or reject produces no fires while another run is active.
func PlanFires(rec Record, now time.Time, hasActive bool) (FirePlan, error) {
	now = now.UTC()
	if rec.Status != StatusEnabled {
		next, err := NextAfter(rec, now)
		if err != nil {
			return FirePlan{}, err
		}
		return FirePlan{NextFireAt: next, SkipReason: "disabled"}, nil
	}
	nextFuture, err := NextAfter(rec, now)
	if err != nil {
		return FirePlan{}, err
	}
	if hasActive && rec.OverlapPolicy != OverlapQueue {
		reason := "overlap-skip"
		if rec.OverlapPolicy == OverlapReject {
			reason = "overlap-reject"
		}
		return FirePlan{NextFireAt: nextFuture, SkipReason: reason}, nil
	}

	due := rec.NextFireAt.UTC()
	if due.IsZero() || due.After(now) {
		if due.IsZero() {
			due = nextFuture
		}
		return FirePlan{NextFireAt: due}, nil
	}

	missed, err := collectMissed(rec, due, now)
	if err != nil {
		return FirePlan{}, err
	}
	fires := selectFires(rec, missed, now)
	return FirePlan{Fires: fires, NextFireAt: nextFuture}, nil
}

func collectMissed(rec Record, due, now time.Time) ([]time.Time, error) {
	var out []time.Time
	slot := due
	for !slot.After(now) {
		out = append(out, slot)
		if len(out) > MaxCatchUp+1 {
			break
		}
		next, err := NextAfter(rec, slot)
		if err != nil {
			return nil, err
		}
		if !next.After(slot) {
			break
		}
		slot = next
	}
	return out, nil
}

func selectFires(rec Record, missed []time.Time, now time.Time) []time.Time {
	if len(missed) == 0 {
		return nil
	}
	// The last missed slot may be the current due tick (on-time or slightly late).
	current := missed[len(missed)-1]
	prior := missed[:len(missed)-1]
	if rec.MisfirePolicy == MisfireFireOnce {
		return []time.Time{current}
	}
	limit := rec.CatchUp
	if limit < 0 {
		limit = 0
	}
	if limit > MaxCatchUp {
		limit = MaxCatchUp
	}
	if len(prior) > limit {
		prior = prior[len(prior)-limit:]
	} else if limit == 0 {
		prior = nil
	}
	out := append([]time.Time{}, prior...)
	out = append(out, current)
	_ = now
	return out
}

// AllowedOverlap reports whether a new fire may start.
func AllowedOverlap(rec Record, hasActive bool) error {
	if !hasActive || rec.OverlapPolicy == OverlapQueue {
		return nil
	}
	if rec.OverlapPolicy == OverlapReject {
		return ErrOverlap
	}
	return nil
}
