package schedule

import (
	"testing"
	"time"
)

func TestPlanFiresNoCatchUpDefault(t *testing.T) {
	now := time.Date(2026, 9, 9, 15, 5, 0, 0, time.UTC)
	rec := Record{
		Timezone:      "UTC",
		Cron:          "0 * * * *",
		OverlapPolicy: OverlapSkip,
		MisfirePolicy: MisfireIgnore,
		CatchUp:       0,
		Status:        StatusEnabled,
		NextFireAt:    time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC),
	}
	plan, err := PlanFires(rec, now, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Fires) != 1 || !plan.Fires[0].Equal(time.Date(2026, 9, 9, 15, 0, 0, 0, time.UTC)) {
		t.Fatalf("no-catch-up should fire only the current slot, got %v", plan.Fires)
	}
	if plan.NextFireAt.Hour() != 16 {
		t.Fatalf("next = %s", plan.NextFireAt)
	}
}

func TestPlanFiresCatchUpBounded(t *testing.T) {
	now := time.Date(2026, 9, 9, 15, 5, 0, 0, time.UTC)
	rec := Record{
		Timezone:      "UTC",
		Cron:          "0 * * * *",
		OverlapPolicy: OverlapSkip,
		MisfirePolicy: MisfireIgnore,
		CatchUp:       2,
		Status:        StatusEnabled,
		NextFireAt:    time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC),
	}
	plan, err := PlanFires(rec, now, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Fires) != 3 {
		t.Fatalf("catch-up 2 + current = 3, got %v", plan.Fires)
	}
}

func TestPlanFiresOverlapSkip(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	rec := Record{
		Timezone:      "UTC",
		Cron:          "0 * * * *",
		OverlapPolicy: OverlapSkip,
		MisfirePolicy: MisfireIgnore,
		Status:        StatusEnabled,
		NextFireAt:    now,
	}
	plan, err := PlanFires(rec, now, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Fires) != 0 || plan.SkipReason != "overlap-skip" {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestPlanFiresOverlapReject(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	rec := Record{
		Timezone:      "UTC",
		Interval:      "PT15M",
		OverlapPolicy: OverlapReject,
		MisfirePolicy: MisfireIgnore,
		Status:        StatusEnabled,
		NextFireAt:    now,
	}
	plan, err := PlanFires(rec, now, true)
	if err != nil {
		t.Fatal(err)
	}
	if plan.SkipReason != "overlap-reject" || len(plan.Fires) != 0 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestPlanFiresDisabled(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	rec := Record{
		Timezone:      "UTC",
		Cron:          "0 * * * *",
		OverlapPolicy: OverlapSkip,
		MisfirePolicy: MisfireIgnore,
		Status:        StatusDisabled,
		NextFireAt:    now,
	}
	plan, err := PlanFires(rec, now, false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.SkipReason != "disabled" || len(plan.Fires) != 0 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestPlanFiresMisfireOnce(t *testing.T) {
	now := time.Date(2026, 9, 9, 15, 5, 0, 0, time.UTC)
	rec := Record{
		Timezone:      "UTC",
		Cron:          "0 * * * *",
		OverlapPolicy: OverlapSkip,
		MisfirePolicy: MisfireFireOnce,
		CatchUp:       5,
		Status:        StatusEnabled,
		NextFireAt:    time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC),
	}
	plan, err := PlanFires(rec, now, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Fires) != 1 {
		t.Fatalf("fire-once should emit one slot, got %v", plan.Fires)
	}
}
