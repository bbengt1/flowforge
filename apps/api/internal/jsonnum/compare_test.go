package jsonnum

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestCompareExact(t *testing.T) {
	big := json.Number("9007199254740993")
	for _, c := range []struct {
		a, b any
		want int
	}{
		{big, int64(1 << 53), 1},
		{big, float64(1 << 53), 1},
		{int64(1 << 53), big, -1},
		{big, json.Number("9007199254740993"), 0},
		{big, uint64(9007199254740993), 0},
		{json.Number("1.5"), 1.5, 0},
		{int64(-5), float64(-5), 0},
		{json.Number("-9007199254740993"), int64(-(1 << 53)), -1},
	} {
		got, err := Compare(c.a, c.b)
		if err != nil || got != c.want {
			t.Fatalf("%v vs %v: %d %v", c.a, c.b, got, err)
		}
	}
	if _, err := Compare(json.Number(strings.Repeat("9", 500)), 1); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("huge: %v", err)
	}
	if _, err := Compare(json.Number("1e999"), 1); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("exp: %v", err)
	}
	if _, err := Compare("1", 1); !errors.Is(err, ErrNotNumber) {
		t.Fatalf("string: %v", err)
	}
	if ok, _ := IsInteger(json.Number("123456789012345678901234567890")); !ok {
		t.Fatal("IsInteger")
	}
	if i, ok := Int64(big); !ok || i != 9007199254740993 {
		t.Fatal("Int64")
	}
	if _, ok := Int64(json.Number("9223372036854775808")); ok {
		t.Fatal("Int64 overflow")
	}
	if _, ok := Float64(big); ok {
		t.Fatal("Float64 inexact")
	}
}
