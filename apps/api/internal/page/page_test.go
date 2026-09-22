package page

import (
	"fmt"
	"math"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestParseIntKeyRejectsOutOfRange(t *testing.T) {
	got, err := ParseIntKey(IntKey(7))
	if err != nil || got != 7 {
		t.Fatalf("round trip = %d %v", got, err)
	}
	got, err = ParseIntKey(IntKey(0))
	if err != nil || got != 0 {
		t.Fatalf("zero = %d %v", got, err)
	}
	got, err = ParseIntKey("2147483647")
	if err != nil || got != math.MaxInt32 {
		t.Fatalf("max int32 = %d %v", got, err)
	}
	for _, raw := range []string{"-1", "2147483648", "9223372036854775807", "9223372036854775808"} {
		if _, err := ParseIntKey(raw); err != ErrInvalid {
			t.Fatalf("ParseIntKey(%q) err = %v, want ErrInvalid", raw, err)
		}
	}
}

func TestParseLimitCapsAndRejects(t *testing.T) {
	q, err := Parse(url.Values{})
	if err != nil || !q.Bound || q.Limit != DefaultLimit || q.Cursor != "" || q.Q != "" {
		t.Fatalf("default = %+v %v", q, err)
	}
	q, err = Parse(url.Values{"limit": {"1"}})
	if err != nil || q.Limit != 1 {
		t.Fatalf("min = %+v %v", q, err)
	}
	q, err = Parse(url.Values{"limit": {"100"}})
	if err != nil || q.Limit != MaxLimit {
		t.Fatalf("max = %+v %v", q, err)
	}
	for _, raw := range []string{"0", "-1", "101", "50.5", "nope", "999999"} {
		if _, err := Parse(url.Values{"limit": {raw}}); err != ErrInvalid {
			t.Fatalf("limit %q err = %v", raw, err)
		}
	}
}

func TestParseRejectsBadCursorAndQuery(t *testing.T) {
	if _, err := Parse(url.Values{"cursor": {"not-a-cursor"}}); err != ErrInvalid {
		t.Fatalf("cursor err = %v", err)
	}
	if _, err := Parse(url.Values{"q": {"ok value"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(url.Values{"q": {strings.Repeat("a", maxQueryRune+1)}}); err != ErrInvalid {
		t.Fatal("expected long q to fail")
	}
	if _, err := Parse(url.Values{"q": {"bad\nsecret"}}); err != ErrInvalid {
		t.Fatal("expected control character to fail")
	}
	q, err := Parse(url.Values{"q": {"  kept  "}})
	if err != nil || q.Q != "kept" {
		t.Fatalf("trim = %+v %v", q, err)
	}
}

func TestCursorRoundTripAndCollectionMismatch(t *testing.T) {
	key := Key{K: TimeKey(time.Date(2026, 9, 22, 1, 2, 3, 4, time.UTC)), ID: "11111111-1111-4111-8111-111111111111"}
	cur, err := Encode(ColWorkflow, key)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decode(ColWorkflow, cur)
	if err != nil || got.K != key.K || got.ID != key.ID {
		t.Fatalf("decode = %+v %v", got, err)
	}
	if _, err := Decode(ColCredential, cur); err != ErrInvalid {
		t.Fatalf("cross-collection err = %v", err)
	}
	if _, err := Encode(ColWorkflow, Key{K: "x", ID: "not-a-uuid"}); err != ErrInvalid {
		t.Fatal("expected bad id to fail")
	}
}

func TestSelectLimitCursorStabilityAndEmptyNext(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	names := []string{"alpha", "beta", "alpha-2", "gamma", "alp"}
	var rows []testRow
	for i := 0; i < 5; i++ {
		rows = append(rows, testRow{
			ID:   fmt.Sprintf("11111111-1111-4111-8111-%012d", i),
			At:   base.Add(time.Duration(i) * time.Second),
			Name: names[i],
		})
	}
	keyFn := func(r testRow) Key {
		return Key{K: TimeKey(r.At), ID: r.ID}
	}
	q := Query{Bound: true, Limit: 2}
	page1, next, err := Select(ColWorkflow, q, true, rows, keyFn, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(page1) != 2 || next == "" {
		t.Fatalf("page1=%v next=%q", ids(page1), next)
	}
	again, next2, err := Select(ColWorkflow, q, true, rows, keyFn, nil)
	if err != nil || next2 != next || ids(again) != ids(page1) {
		t.Fatalf("unstable first page %v/%q vs %v/%q (%v)", ids(again), next2, ids(page1), next, err)
	}
	q.Cursor = next
	page2, next, err := Select(ColWorkflow, q, true, rows, keyFn, nil)
	if err != nil {
		t.Fatal(err)
	}
	stable, nextStable, err := Select(ColWorkflow, q, true, rows, keyFn, nil)
	if err != nil || ids(stable) != ids(page2) || nextStable != next {
		t.Fatalf("unstable cursor page %v vs %v", ids(stable), ids(page2))
	}
	q.Cursor = next
	page3, next, err := Select(ColWorkflow, q, true, rows, keyFn, nil)
	if err != nil {
		t.Fatal(err)
	}
	if next != "" {
		t.Fatalf("expected empty next, got %q (page %v)", next, ids(page3))
	}
	if len(page3) != 1 {
		t.Fatalf("last page = %v", ids(page3))
	}
	seen := map[string]int{}
	for _, id := range append(append(idsOf(page1), idsOf(page2)...), idsOf(page3)...) {
		seen[id]++
	}
	if len(seen) != 5 {
		t.Fatalf("coverage = %v", seen)
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("id %s repeated %d", id, n)
		}
	}

	searched, next, err := Select(ColWorkflow, Query{Bound: true, Limit: 50}, true, rows, keyFn, func(r testRow) bool {
		return Hit("alpha", r.Name)
	})
	if err != nil || next != "" || len(searched) != 2 {
		t.Fatalf("search = %v next=%q err=%v", ids(searched), next, err)
	}
}

func TestILikeEscapesWildcards(t *testing.T) {
	got := ILikePattern(`100%_done\`)
	if got != `%100\%\_done\\%` {
		t.Fatalf("pattern = %q", got)
	}
}

type testRow struct {
	ID   string
	At   time.Time
	Name string
}

func ids(rows []testRow) string {
	return strings.Join(idsOf(rows), ",")
}

func idsOf(rows []testRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.ID
	}
	return out
}
