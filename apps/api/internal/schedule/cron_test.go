package schedule

import (
	"testing"
	"time"
)

func TestNextAfterTimezoneExplicit(t *testing.T) {
	chicago, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Fatal(err)
	}
	rec := Record{Timezone: "America/Chicago", Cron: "0 9 * * *", OverlapPolicy: OverlapSkip, MisfirePolicy: MisfireIgnore}
	// 14:30 UTC is 09:30 CDT on 2026-09-09.
	after := time.Date(2026, 9, 9, 14, 30, 0, 0, time.UTC)
	next, err := NextAfter(rec, after)
	if err != nil {
		t.Fatal(err)
	}
	local := next.In(chicago)
	if local.Hour() != 9 || local.Minute() != 0 || local.Day() != 10 {
		t.Fatalf("next Chicago 09:00 = %s (%s)", next, local)
	}

	utcRec := rec
	utcRec.Timezone = "UTC"
	utcNext, err := NextAfter(utcRec, after)
	if err != nil {
		t.Fatal(err)
	}
	if utcNext.Hour() != 9 || utcNext.Day() != 10 {
		t.Fatalf("next UTC 09:00 = %s", utcNext)
	}
	if next.Equal(utcNext) {
		t.Fatal("Chicago and UTC 09:00 cron must not share the same instant")
	}
}

func TestNextAfterRejectsUnknownTimezone(t *testing.T) {
	_, err := NextAfter(Record{Timezone: "Not/AZone", Cron: "* * * * *"}, time.Now())
	if err != ErrTimezone {
		t.Fatalf("err = %v", err)
	}
}

func TestNextAfterInterval(t *testing.T) {
	rec := Record{Timezone: "UTC", Interval: "PT1H", OverlapPolicy: OverlapSkip, MisfirePolicy: MisfireIgnore}
	after := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	next, err := NextAfter(rec, after)
	if err != nil {
		t.Fatal(err)
	}
	if !next.Equal(after.Add(time.Hour)) {
		t.Fatalf("interval next = %s", next)
	}
}
