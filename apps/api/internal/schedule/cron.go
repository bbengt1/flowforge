package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type cronField struct {
	min, max int
	allowed  map[int]struct{}
}

type cronExpr struct {
	min, hour, dom, month, dow cronField
}

func parseCron(expr string) (cronExpr, error) {
	parts := strings.Fields(strings.TrimSpace(expr))
	if len(parts) != 5 {
		return cronExpr{}, fmt.Errorf("cron must be a 5-field expression")
	}
	min, err := parseField(parts[0], 0, 59)
	if err != nil {
		return cronExpr{}, err
	}
	hour, err := parseField(parts[1], 0, 23)
	if err != nil {
		return cronExpr{}, err
	}
	dom, err := parseField(parts[2], 1, 31)
	if err != nil {
		return cronExpr{}, err
	}
	month, err := parseField(parts[3], 1, 12)
	if err != nil {
		return cronExpr{}, err
	}
	dow, err := parseField(parts[4], 0, 6)
	if err != nil {
		return cronExpr{}, err
	}
	return cronExpr{min: min, hour: hour, dom: dom, month: month, dow: dow}, nil
}

func parseField(raw string, min, max int) (cronField, error) {
	out := cronField{min: min, max: max, allowed: map[int]struct{}{}}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return cronField{}, fmt.Errorf("empty cron field")
		}
		step := 1
		rangePart := part
		if i := strings.IndexByte(part, '/'); i >= 0 {
			rangePart = part[:i]
			n, err := strconv.Atoi(part[i+1:])
			if err != nil || n <= 0 {
				return cronField{}, fmt.Errorf("invalid cron step")
			}
			step = n
		}
		start, end := min, max
		if rangePart != "*" {
			if j := strings.IndexByte(rangePart, '-'); j >= 0 {
				a, err1 := strconv.Atoi(rangePart[:j])
				b, err2 := strconv.Atoi(rangePart[j+1:])
				if err1 != nil || err2 != nil || a < min || b > max || a > b {
					return cronField{}, fmt.Errorf("invalid cron range")
				}
				start, end = a, b
			} else {
				n, err := strconv.Atoi(rangePart)
				if err != nil || n < min || n > max {
					return cronField{}, fmt.Errorf("invalid cron value")
				}
				start, end = n, n
			}
		}
		for v := start; v <= end; v += step {
			out.allowed[v] = struct{}{}
		}
	}
	if len(out.allowed) == 0 {
		return cronField{}, fmt.Errorf("cron field matches nothing")
	}
	return out, nil
}

func (f cronField) match(v int) bool {
	_, ok := f.allowed[v]
	return ok
}

func (c cronExpr) match(t time.Time) bool {
	if !c.min.match(t.Minute()) || !c.hour.match(t.Hour()) || !c.month.match(int(t.Month())) {
		return false
	}
	domOK := c.dom.match(t.Day())
	dowOK := c.dow.match(int(t.Weekday()))
	// Standard cron: when both DOM and DOW are restricted, match either.
	domStar := len(c.dom.allowed) == (c.dom.max - c.dom.min + 1)
	dowStar := len(c.dow.allowed) == (c.dow.max - c.dow.min + 1)
	switch {
	case domStar && dowStar:
		return true
	case domStar:
		return dowOK
	case dowStar:
		return domOK
	default:
		return domOK || dowOK
	}
}

// LoadLocation accepts an IANA name. UTC and GMT are allowed.
func LoadLocation(name string) (*time.Location, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrTimezone
	}
	if name == "UTC" || name == "GMT" {
		return time.UTC, nil
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, ErrTimezone
	}
	return loc, nil
}

// NextAfter returns the next fire strictly after `after` in the schedule timezone.
func NextAfter(rec Record, after time.Time) (time.Time, error) {
	loc, err := LoadLocation(rec.Timezone)
	if err != nil {
		return time.Time{}, err
	}
	after = after.In(loc)
	if rec.Cron != "" {
		expr, err := parseCron(rec.Cron)
		if err != nil {
			return time.Time{}, ErrInvalid
		}
		t := after.Add(time.Minute).Truncate(time.Minute)
		for i := 0; i < 366*24*60; i++ {
			if expr.match(t) {
				return t.UTC(), nil
			}
			t = t.Add(time.Minute)
		}
		return time.Time{}, ErrInvalid
	}
	d, err := workflowParseInterval(rec.Interval)
	if err != nil {
		return time.Time{}, err
	}
	return after.Add(d).UTC(), nil
}

func nextAfterOrEqual(rec Record, at time.Time) (time.Time, error) {
	// NextAfter is exclusive. For catch-up enumeration we want the next slot
	// after `at` when `at` itself is already a scheduled instant.
	return NextAfter(rec, at)
}

func workflowParseInterval(s string) (time.Duration, error) {
	return parseInterval(s)
}
