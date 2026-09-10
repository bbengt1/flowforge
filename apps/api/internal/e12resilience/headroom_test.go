package e12resilience

import (
	"math"
	"testing"
)

func TestHeadroomRatio(t *testing.T) {
	t.Parallel()
	if got := Headroom(8, 4); got != 2 {
		t.Fatalf("Headroom(8,4)=%v want 2", got)
	}
	if got := Headroom(8, 3); got < 2.6 || got > 2.7 {
		t.Fatalf("Headroom(8,3)=%v", got)
	}
	if !MeetsHeadroom(8, 4, MinHeadroom) {
		t.Fatal("8 vs 4 must meet 2×")
	}
	if MeetsHeadroom(8, 5, MinHeadroom) {
		t.Fatal("8 vs 5 must fail 2×")
	}
	if !math.IsInf(Headroom(8, 0), 1) {
		t.Fatal("zero peak with capacity should be +Inf")
	}
	if got := finiteHeadroom(8, 0); got != 99 {
		t.Fatalf("finiteHeadroom zero peak = %v", got)
	}
	if Headroom(0, 1) != 0 {
		t.Fatal("zero capacity should be 0")
	}
}
