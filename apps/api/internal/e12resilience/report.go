package e12resilience

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"
)

// finiteHeadroom is JSON-safe: +Inf (zero peak) becomes a large finite ratio.
func finiteHeadroom(capacity, peak float64) float64 {
	r := Headroom(capacity, peak)
	if math.IsInf(r, 1) {
		return 99
	}
	if math.IsInf(r, -1) || math.IsNaN(r) {
		return 0
	}
	return r
}

// Report is the machine-readable E12.2 capacity evidence payload.
type Report struct {
	ID         string            `json:"id"`
	Mode       string            `json:"mode"`
	RanAt      string            `json:"ranAt"`
	MinRatio   float64           `json:"minHeadroom"`
	Peaks      Peaks             `json:"peaks"`
	Capacity   Capacity          `json:"capacity"`
	Headroom   map[string]float64 `json:"headroom"`
	WorkerLoss WorkerLossProof   `json:"workerLoss"`
	OK         bool              `json:"ok"`
	Claims     []string          `json:"claims"`
	Failures   []string          `json:"failures,omitempty"`
}

// Peaks are observed maxima during the bounded load window.
type Peaks struct {
	DBConnections     int     `json:"dbConnections"`
	DBWritesPerSec    float64 `json:"dbWritesPerSec"`
	QueueLagSeconds   float64 `json:"queueLagSeconds"`
	QueueDepth        int     `json:"queueDepth"`
	StorageGrowthBytes int64  `json:"storageGrowthBytes"`
	LoadJobs          int     `json:"loadJobs"`
	LoadWorkers       int     `json:"loadWorkers"`
	LoadElapsedSec    float64 `json:"loadElapsedSec"`
}

// Capacity is configured or measured headroom denominators.
type Capacity struct {
	DBConnections           int     `json:"dbConnections"`
	DBWritesPerSec             float64 `json:"dbWritesPerSec"`
	QueueLagSecondsSLO         float64 `json:"queueLagSecondsSLO"`
	QueueDepthBudget           int     `json:"queueDepthBudget"`
	StorageBudgetBytes         int64   `json:"storageBudgetBytes"`
	PostgresMaxConnections     int     `json:"postgresMaxConnections"`
	MeasuredWriteCeilingPS     float64 `json:"measuredWriteCeilingPerSec"`
	DocumentedWriteBudgetPerSec float64 `json:"documentedWriteBudgetPerSec"`
}

// WorkerLossProof records the lease-expiry / fencing recovery path.
type WorkerLossProof struct {
	Recovered            int  `json:"recovered"`
	BecameIndeterminate  bool `json:"becameIndeterminate"`
	StaleCompleteRejected bool `json:"staleCompleteRejected"`
}

func (r Report) evaluate() Report {
	r.MinRatio = MinHeadroom
	r.Headroom = map[string]float64{
		"dbConnections":   finiteHeadroom(float64(r.Capacity.DBConnections), float64(r.Peaks.DBConnections)),
		"dbWritesPerSec":  finiteHeadroom(r.Capacity.DBWritesPerSec, r.Peaks.DBWritesPerSec),
		"queueLagSeconds": finiteHeadroom(r.Capacity.QueueLagSecondsSLO, r.Peaks.QueueLagSeconds),
		"queueDepth":      finiteHeadroom(float64(r.Capacity.QueueDepthBudget), float64(r.Peaks.QueueDepth)),
		"storageGrowth":   finiteHeadroom(float64(r.Capacity.StorageBudgetBytes), float64(r.Peaks.StorageGrowthBytes)),
	}
	var fails []string
	checks := []struct {
		key      string
		capacity float64
		peak     float64
	}{
		{"dbConnections", float64(r.Capacity.DBConnections), float64(r.Peaks.DBConnections)},
		{"dbWritesPerSec", r.Capacity.DBWritesPerSec, r.Peaks.DBWritesPerSec},
		{"queueLagSeconds", r.Capacity.QueueLagSecondsSLO, r.Peaks.QueueLagSeconds},
		{"storageGrowth", float64(r.Capacity.StorageBudgetBytes), float64(r.Peaks.StorageGrowthBytes)},
	}
	for _, c := range checks {
		if !MeetsHeadroom(c.capacity, c.peak, MinHeadroom) {
			fails = append(fails, fmt.Sprintf("%s headroom %.3f < %.1f (capacity=%g peak=%g)",
				c.key, Headroom(c.capacity, c.peak), MinHeadroom, c.capacity, c.peak))
		}
	}
	if !r.WorkerLoss.BecameIndeterminate || !r.WorkerLoss.StaleCompleteRejected || r.WorkerLoss.Recovered < 1 {
		fails = append(fails, "worker-loss recovery path did not fence a stale completer")
	}
	r.Failures = fails
	r.OK = len(fails) == 0
	r.Claims = []string{
		fmt.Sprintf("Database connection pool (MaxConns=%d) is ≥2× observed peak connections (%d).", r.Capacity.DBConnections, r.Peaks.DBConnections),
		fmt.Sprintf("Database write capacity (%.1f/s measured ceiling; planning budget %.1f/s) is ≥2× observed peak writes (%.1f/s).", r.Capacity.MeasuredWriteCeilingPS, r.Capacity.DocumentedWriteBudgetPerSec, r.Peaks.DBWritesPerSec),
		fmt.Sprintf("Queue-lag SLO (%.1fs) is ≥2× observed peak lag (%.3fs); depth budget %d vs peak %d.", r.Capacity.QueueLagSecondsSLO, r.Peaks.QueueLagSeconds, r.Capacity.QueueDepthBudget, r.Peaks.QueueDepth),
		fmt.Sprintf("Storage growth budget (%d bytes) is ≥2× observed growth (%d bytes).", r.Capacity.StorageBudgetBytes, r.Peaks.StorageGrowthBytes),
	}
	return r
}

func writeReport(path string, report Report) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}

func stampUTC() string {
	return time.Now().UTC().Truncate(time.Second).Format(time.RFC3339)
}
