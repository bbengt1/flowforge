package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/jackc/pgx/v5"
)

// systemTrigger reports the trigger types that may run with no requester:
// schedule, webhook, and resync. Manual, API, and an unspecified trigger
// always need one.
func systemTrigger(trigger string) bool {
	switch strings.TrimSpace(trigger) {
	case "schedule", "webhook", "resync":
		return true
	default:
		return false
	}
}

// ExecutionTriggerType is the stored trigger type of a run (its policy
// snapshot triggerType), or "manual" when none is stored. It is the one
// definition the claim and the runner share.
func ExecutionTriggerType(exec Execution) string {
	if exec.PolicySnapshot != nil {
		if t, ok := exec.PolicySnapshot["triggerType"].(string); ok && strings.TrimSpace(t) != "" {
			return strings.TrimSpace(t)
		}
	}
	return "manual"
}

// IsSystemTrigger reports whether a run's trigger type may run with no
// requester (schedule, webhook, resync).
func IsSystemTrigger(exec Execution) bool {
	return systemTrigger(ExecutionTriggerType(exec))
}

// MissingActorFailure reports a stored manual or API run whose requester
// is empty, with the step error (MissingActorError) to fail it with. Such
// a run is corrupt and none of its nodes may run. Schedule, webhook, and
// resync runs are system starts and are never refused, and a present
// requester is never refused. A zero execution (no id) is a test double
// that never started a run and is not refused.
//
// ClaimJob (Postgres and memory) applies it inside the claim, so neither
// the in-process runner nor the HTTP-claim compose worker is ever handed
// a job of such a run. The runner keeps a backstop that calls this too.
func MissingActorFailure(exec Execution) (map[string]any, bool) {
	if strings.TrimSpace(exec.ID) == "" || strings.TrimSpace(exec.RequestedBy) != "" {
		return nil, false
	}
	if IsSystemTrigger(exec) {
		return nil, false
	}
	return MissingActorError(), true
}

// failMissingActorJobTx fails a picked, locked, still-queued job of a
// missing-actor run inside the claim transaction: the job and its step
// end failed with MissingActorError (the step never starts), the run is
// rolled up (statusReason missing_actor), and a job.fail audit row is
// written. No fencing token or lease is ever issued for the job.
func failMissingActorJobTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, jobID, executionID string, failure map[string]any) error {
	errRaw, err := marshalObject(failure)
	if err != nil {
		return ErrInvalid
	}
	var stepID string
	if err := tx.QueryRow(ctx, `
		UPDATE execution_jobs
		SET status = 'failed',
		    worker_id = NULL,
		    lease_expires_at = NULL,
		    heartbeat_at = NULL,
		    updated_at = $1
		WHERE id = $2::uuid
		RETURNING execution_step_id::text
	`, now, jobID).Scan(&stepID); err != nil {
		return mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		SET status = 'failed',
		    error_redacted = $2::jsonb,
		    finished_at = COALESCE(finished_at, $1),
		    updated_at = $1
		WHERE id = $3::uuid
	`, now, errRaw, stepID); err != nil {
		return mapDBErr(err)
	}
	if err := rollupExecutionTx(ctx, tx, executionID, now); err != nil {
		return err
	}
	_, err = insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "job.fail",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      "failed",
		Details:      map[string]any{"reason": ReasonMissingActor, "jobId": jobID},
	})
	return err
}
