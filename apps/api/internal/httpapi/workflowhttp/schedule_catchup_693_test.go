package workflowhttp

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"testing"
)

func TestScheduleCatchUpIntExact(t *testing.T) {
	ok := []struct {
		raw  any
		want int
	}{
		{int64(3), 3},
		{3, 3},
		{json.Number("4"), 4},
	}
	for _, tc := range ok {
		got, err := scheduleCatchUpInt(tc.raw)
		if err != nil || got != tc.want {
			t.Fatalf("%#v: got %d, %v; want %d", tc.raw, got, err, tc.want)
		}
	}
	tooLarge := json.Number(strconv.FormatUint(math.MaxUint64, 10) + "0")
	for _, raw := range []any{1.0, 1e2, json.Number("1.0"), json.Number("1e2"), 1.5, json.Number("1.5"), 1e30, json.Number("1e30"), tooLarge, math.Inf(1), math.NaN(), "3"} {
		if _, err := scheduleCatchUpInt(raw); !errors.Is(err, errScheduleCatchUp) {
			t.Fatalf("%#v: err = %v, want the fixed catchUp error", raw, err)
		}
	}
}
