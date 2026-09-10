package e12resilience

import "math"

// MinHeadroom is the E12.2 production-gate ratio: capacity / observed peak.
const MinHeadroom = 2.0

// Headroom returns capacity / peak. Peak <= 0 yields +Inf when capacity > 0.
func Headroom(capacity, peak float64) float64 {
	if peak <= 0 {
		if capacity > 0 {
			return math.Inf(1)
		}
		return 0
	}
	if capacity <= 0 {
		return 0
	}
	return capacity / peak
}

// MeetsHeadroom reports whether capacity is at least minRatio times peak.
func MeetsHeadroom(capacity, peak, minRatio float64) bool {
	if minRatio <= 0 {
		minRatio = MinHeadroom
	}
	return Headroom(capacity, peak) >= minRatio
}
