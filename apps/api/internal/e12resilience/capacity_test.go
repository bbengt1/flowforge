package e12resilience

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5/pgxpool"
)

const capacityYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e12-capacity
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`

func TestE12CapacityHeadroomAndWorkerLoss(t *testing.T) {
	dsn := testDatabaseURL(t)
	mode := loadMode()
	jobs, workers, claimDelay, lagSLO, depthBudget, writeBudget := modeParams(mode)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	appDSN := withAppName(dsn, "e12-resilience")
	app, err := postgres.Open(ctx, appDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if app.Config().MaxConns != postgres.DefaultMaxConns {
		t.Fatalf("app pool MaxConns=%d want %d", app.Config().MaxConns, postgres.DefaultMaxConns)
	}

	store := wfstore.NewPostgres(app)
	wsID, userID := seedCapacityWorkspace(t, ctx, admin)
	scope, err := isolation.Authorize(wsID, userID)
	if err != nil {
		t.Fatal(err)
	}

	normalized, errs := workflow.ParseAndNormalize([]byte(capacityYAML))
	if len(errs) > 0 {
		t.Fatalf("normalize: %v", errs)
	}
	wf, draft, err := store.Create(ctx, scope, wfstore.CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "e12.2"})
	if err != nil {
		t.Fatal(err)
	}

	var maxConnsPG int
	if err := admin.QueryRow(ctx, `SELECT setting::int FROM pg_settings WHERE name = 'max_connections'`).Scan(&maxConnsPG); err != nil {
		t.Fatal(err)
	}
	var sizeBefore int64
	if err := admin.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&sizeBefore); err != nil {
		t.Fatal(err)
	}
	writesBefore := countWorkspaceRows(t, ctx, admin, wsID)

	samples := &peakSampler{admin: admin, app: app, workspaceID: wsID}
	stop := make(chan struct{})
	var samplerWG sync.WaitGroup
	samplerWG.Add(1)
	go func() {
		defer samplerWG.Done()
		samples.loop(ctx, stop)
	}()

	loadStart := time.Now()
	for i := 0; i < jobs; i++ {
		if _, err := store.StartExecution(ctx, scope, wf.ID, wfstore.StartInput{
			VersionID:      ver.ID,
			IdempotencyKey: fmt.Sprintf("e12-cap-%d-%d", time.Now().UnixNano(), i),
		}); err != nil {
			close(stop)
			samplerWG.Wait()
			t.Fatalf("start %d: %v", i, err)
		}
	}

	samples.sample(ctx)

	now := time.Now().UTC()
	claimed, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: "e12-stale", Lease: time.Second})
	if err != nil {
		close(stop)
		samplerWG.Wait()
		t.Fatalf("claim for worker-loss: %v", err)
	}
	recovered, err := store.RecoverExpiredLeases(ctx, scope, now.Add(3*time.Second))
	if err != nil || recovered < 1 {
		close(stop)
		samplerWG.Wait()
		t.Fatalf("recover: n=%d err=%v", recovered, err)
	}
	got, err := store.GetExecutionByID(ctx, scope, claimed.Job.ExecutionID)
	if err != nil {
		close(stop)
		samplerWG.Wait()
		t.Fatal(err)
	}
	if got.Status != wfstore.ExecutionIndeterminate {
		close(stop)
		samplerWG.Wait()
		t.Fatalf("lease loss status = %s", got.Status)
	}
	staleRejected := false
	if _, err := store.CompleteJob(ctx, scope, now.Add(4*time.Second), wfstore.JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "e12-stale", FencingToken: claimed.Job.FencingToken,
	}); err != nil {
		staleRejected = true
	}

	var workerWG sync.WaitGroup
	for i := 0; i < workers; i++ {
		workerWG.Add(1)
		go func(n int) {
			defer workerWG.Done()
			drainJobs(t, ctx, store, scope, fmt.Sprintf("e12-w-%d", n), claimDelay)
		}(i)
	}
	workerWG.Wait()
	loadElapsed := time.Since(loadStart)
	close(stop)
	samplerWG.Wait()

	writesAfter := countWorkspaceRows(t, ctx, admin, wsID)
	var sizeAfter int64
	if err := admin.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&sizeAfter); err != nil {
		t.Fatal(err)
	}

	writeElapsed := loadElapsed.Seconds()
	if writeElapsed < 0.001 {
		writeElapsed = 0.001
	}
	rowDelta := writesAfter - writesBefore
	if rowDelta < 1 {
		rowDelta = 1
	}
	observedWrites := float64(rowDelta) / writeElapsed
	ceiling := measureWriteCeiling(t, ctx, admin)
	if ceiling < observedWrites*MinHeadroom {
		t.Fatalf("write ceiling %.1f/s is below 2× observed %.1f/s", ceiling, observedWrites)
	}

	peakConns := samples.maxAppConns
	if samples.maxPoolAcquired > peakConns {
		peakConns = samples.maxPoolAcquired
	}
	if peakConns < 1 {
		peakConns = 1
	}
	growth := sizeAfter - sizeBefore
	if growth < 0 {
		growth = 0
	}

	report := Report{
		ID:    "E12.2-capacity",
		Mode:  mode,
		RanAt: stampUTC(),
		Peaks: Peaks{
			DBConnections:      peakConns,
			DBWritesPerSec:     observedWrites,
			QueueLagSeconds:    samples.maxLagSec,
			QueueDepth:         samples.maxDepth,
			StorageGrowthBytes: growth,
			LoadJobs:           jobs,
			LoadWorkers:        workers,
			LoadElapsedSec:     loadElapsed.Seconds(),
		},
		Capacity: Capacity{
			DBConnections:              int(postgres.DefaultMaxConns),
			DBWritesPerSec:             ceiling,
			QueueLagSecondsSLO:         lagSLO,
			QueueDepthBudget:           depthBudget,
			StorageBudgetBytes:         1 << 30, // 1 GiB documented working-set budget
			PostgresMaxConnections:     maxConnsPG,
			MeasuredWriteCeilingPS:     ceiling,
			DocumentedWriteBudgetPerSec: writeBudget,
		},
		WorkerLoss: WorkerLossProof{
			Recovered:             recovered,
			BecameIndeterminate:   got.Status == wfstore.ExecutionIndeterminate,
			StaleCompleteRejected: staleRejected,
		},
	}.evaluate()

	path := os.Getenv("E12_CAPACITY_JSON")
	if path == "" {
		if runDir := strings.TrimSpace(os.Getenv("E12_RUN_DIR")); runDir != "" {
			path = runDir + "/capacity-last-run.json"
		}
	}
	if path != "" {
		if err := writeReport(path, report); err != nil {
			t.Fatalf("write capacity report: %v", err)
		}
		t.Logf("wrote %s", path)
	}

	if !report.OK {
		t.Fatalf("E12.2 capacity headroom failed: %s", strings.Join(report.Failures, "; "))
	}
}

func drainJobs(t *testing.T, ctx context.Context, store wfstore.Store, scope isolation.Scope, workerID string, delay time.Duration) {
	t.Helper()
	for {
		if ctx.Err() != nil {
			return
		}
		now := time.Now().UTC()
		res, err := store.ClaimJob(ctx, scope, now, wfstore.ClaimInput{WorkerID: workerID, Lease: 30 * time.Second})
		if errors.Is(err, wfstore.ErrEmptyClaim) {
			return
		}
		if err != nil {
			t.Errorf("claim %s: %v", workerID, err)
			return
		}
		if delay > 0 {
			time.Sleep(delay)
		}
		if _, err := store.CompleteJob(ctx, scope, time.Now().UTC(), wfstore.JobActionInput{
			JobID: res.Job.ID, WorkerID: workerID, FencingToken: res.Job.FencingToken,
		}); err != nil {
			t.Errorf("complete %s job %s: %v", workerID, res.Job.ID, err)
			return
		}
	}
}

type peakSampler struct {
	admin           *pgxpool.Pool
	app             *pgxpool.Pool
	workspaceID     string
	maxAppConns     int
	maxPoolAcquired int
	maxDepth        int
	maxLagSec       float64
	mu              sync.Mutex
}

func (s *peakSampler) loop(ctx context.Context, stop <-chan struct{}) {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		s.sample(ctx)
		select {
		case <-stop:
			s.sample(ctx)
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *peakSampler) sample(ctx context.Context) {
	qctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var appConns int
	_ = s.admin.QueryRow(qctx, `
		SELECT count(*) FROM pg_stat_activity
		WHERE datname = current_database()
		  AND application_name = 'e12-resilience'`).Scan(&appConns)

	var depth int
	var lag float64
	_ = s.admin.QueryRow(qctx, `
		SELECT
			count(*) FILTER (WHERE status = 'queued'),
			COALESCE(max(EXTRACT(EPOCH FROM (now() - available_at))) FILTER (WHERE status = 'queued'), 0)
		FROM execution_jobs
		WHERE workspace_id = $1::uuid`, s.workspaceID).Scan(&depth, &lag)

	acquired := 0
	if s.app != nil {
		acquired = int(s.app.Stat().AcquiredConns())
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if appConns > s.maxAppConns {
		s.maxAppConns = appConns
	}
	if acquired > s.maxPoolAcquired {
		s.maxPoolAcquired = acquired
	}
	if depth > s.maxDepth {
		s.maxDepth = depth
	}
	if lag > s.maxLagSec {
		s.maxLagSec = lag
	}
}

func measureWriteCeiling(t *testing.T, ctx context.Context, admin *pgxpool.Pool) float64 {
	t.Helper()
	conn, err := admin.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire write probe: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `CREATE TEMP TABLE e12_write_probe (id bigserial PRIMARY KEY, payload text NOT NULL)`); err != nil {
		t.Fatalf("temp table: %v", err)
	}
	const rows = 4000
	started := time.Now()
	if _, err := conn.Exec(ctx, `INSERT INTO e12_write_probe (payload) SELECT repeat('x', 32) FROM generate_series(1, $1)`, rows); err != nil {
		t.Fatalf("write probe: %v", err)
	}
	elapsed := time.Since(started).Seconds()
	if elapsed < 0.001 {
		elapsed = 0.001
	}
	return float64(rows) / elapsed
}

func seedCapacityWorkspace(t *testing.T, ctx context.Context, db identity.DB) (string, string) {
	t.Helper()
	store := identity.NewPostgres(db)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	tenant, err := store.CreateTenant(ctx, "e12-"+suffix[len(suffix)-12:], "E12")
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUser(ctx, "https://idp.example", "e12-"+suffix, "E12")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(ctx, tenant.ID, "cap-"+suffix[len(suffix)-8:], "Capacity", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	return ws.ID, user.ID
}

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	return dsn
}

func loadMode() string {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("E12_LOAD_MODE")))
	switch mode {
	case "full", "local":
		return "full"
	default:
		return "ci"
	}
}

func modeParams(mode string) (jobs, workers int, delay time.Duration, lagSLO float64, depthBudget int, writeBudget float64) {
	// CI is timed/size-bounded. Full local raises enqueue count and the
	// write-budget planning number; the 2× gate still uses measured peaks.
	if mode == "full" {
		return 80, 3, 15 * time.Millisecond, 30, 256, 2500
	}
	return 16, 2, 20 * time.Millisecond, 15, 64, 1000
}

func withAppName(dsn, name string) string {
	if strings.Contains(dsn, "application_name=") {
		return dsn
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return dsn + sep + "application_name=" + name
}

func countWorkspaceRows(t *testing.T, ctx context.Context, admin *pgxpool.Pool, workspaceID string) int64 {
	t.Helper()
	var n int64
	if err := admin.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM executions WHERE workspace_id = $1::uuid) +
			(SELECT count(*) FROM execution_steps WHERE workspace_id = $1::uuid) +
			(SELECT count(*) FROM execution_jobs WHERE workspace_id = $1::uuid) +
			(SELECT count(*) FROM audit_events WHERE workspace_id = $1::uuid)`,
		workspaceID).Scan(&n); err != nil {
		t.Fatalf("count workspace rows: %v", err)
	}
	return n
}
