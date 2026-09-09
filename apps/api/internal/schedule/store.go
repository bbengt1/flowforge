// Package schedule persists timezone-explicit, version-pinned workflow
// schedules and computes safe catch-up / overlap fire plans.
package schedule

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Persistence errors.
var (
	ErrNotFound         = errors.New("not found")
	ErrConflict         = errors.New("conflict")
	ErrInvalid          = errors.New("invalid")
	ErrNoScope          = errors.New("workspace scope is not set")
	ErrDisabled         = errors.New("schedule is disabled")
	ErrUnpublished      = errors.New("schedule must pin a published workflow version")
	ErrStoreUnavailable = errors.New("schedule store is unavailable")
	ErrOverlap          = errors.New("schedule overlap rejected")
	ErrTimezone         = errors.New("schedule timezone is not a valid IANA name")
)

// Lifecycle and policy values.
const (
	TypeSchedule   = "schedule"
	StatusEnabled  = "enabled"
	StatusDisabled = "disabled"

	OverlapSkip   = "skip"
	OverlapReject = "reject"
	OverlapQueue  = "queue"

	MisfireIgnore   = "ignore"
	MisfireFireOnce = "fire-once"

	DefaultOverlap = OverlapSkip
	DefaultMisfire = MisfireIgnore
	DefaultCatchUp = 0
	MaxCatchUp     = 5
	MaxLastError   = 500
)

// Record is a workspace-owned, version-pinned schedule.
type Record struct {
	ID                string     `json:"id"`
	WorkflowID        string     `json:"workflowId"`
	WorkflowVersionID string     `json:"workflowVersionId"`
	WorkflowDigest    string     `json:"workflowDigest,omitempty"`
	TriggerID         string     `json:"triggerId,omitempty"`
	Timezone          string     `json:"timezone"`
	Cron              string     `json:"cron,omitempty"`
	Interval          string     `json:"interval,omitempty"`
	OverlapPolicy     string     `json:"overlapPolicy"`
	MisfirePolicy     string     `json:"misfirePolicy"`
	CatchUp           int        `json:"catchUp"`
	Status            string     `json:"status"`
	NextFireAt        time.Time  `json:"nextFireAt"`
	LastFiredAt       *time.Time `json:"lastFiredAt,omitempty"`
	LastExecutionID   string     `json:"lastExecutionId,omitempty"`
	LastError         string     `json:"lastError,omitempty"`
	CreatedBy         string     `json:"createdBy,omitempty"`
	UpdatedBy         string     `json:"updatedBy,omitempty"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

// CreateInput creates a schedule pinned to a published version.
type CreateInput struct {
	WorkflowID        string
	WorkflowVersionID string
	WorkflowDigest    string
	TriggerID         string
	Timezone          string
	Cron              string
	Interval          string
	OverlapPolicy     string
	MisfirePolicy     string
	CatchUp           *int
}

// UpdateInput changes pinned version or schedule fields.
type UpdateInput struct {
	WorkflowVersionID *string
	WorkflowDigest    *string
	TriggerID         *string
	Timezone          *string
	Cron              *string
	Interval          *string
	OverlapPolicy     *string
	MisfirePolicy     *string
	CatchUp           *int
}

// FireUpdate records a dispatcher outcome.
type FireUpdate struct {
	NextFireAt      time.Time
	LastFiredAt     *time.Time
	LastExecutionID string
	LastError       string
}

// Catalog is the UI vocabulary for schedule surfaces.
type Catalog struct {
	Statuses              []string `json:"statuses"`
	OverlapPolicies       []string `json:"overlapPolicies"`
	MisfirePolicies       []string `json:"misfirePolicies"`
	DefaultOverlapPolicy  string   `json:"defaultOverlapPolicy"`
	DefaultMisfirePolicy  string   `json:"defaultMisfirePolicy"`
	DefaultCatchUp        int      `json:"defaultCatchUp"`
	MaxCatchUp            int      `json:"maxCatchUp"`
	TimezoneRequired      bool     `json:"timezoneRequired"`
	SafeDefaults          string   `json:"safeDefaults"`
	FailClosedUnpublished bool     `json:"failClosedUnpublished"`
	FailClosedDisabled    bool     `json:"failClosedDisabled"`
	IdempotencyKeyPattern string   `json:"idempotencyKeyPattern"`
	DispatchRoute         string   `json:"dispatchRoute"`
	Permission            string   `json:"permission"`
	ViewPermission        string   `json:"viewPermission"`
	DispatchPermission    string   `json:"dispatchPermission"`
	CSRF                  bool     `json:"csrf"`
	Help                  string   `json:"help"`
}

// TypeCatalog returns stable schedule vocabulary for Chloe.
func TypeCatalog() Catalog {
	return Catalog{
		Statuses:              []string{StatusEnabled, StatusDisabled},
		OverlapPolicies:       []string{OverlapSkip, OverlapReject, OverlapQueue},
		MisfirePolicies:       []string{MisfireIgnore, MisfireFireOnce},
		DefaultOverlapPolicy:  DefaultOverlap,
		DefaultMisfirePolicy:  DefaultMisfire,
		DefaultCatchUp:        DefaultCatchUp,
		MaxCatchUp:            MaxCatchUp,
		TimezoneRequired:      true,
		SafeDefaults:          "No catch-up and one active execution per schedule (overlapPolicy=skip, catchUp=0, misfirePolicy=ignore) unless the workflow is verified idempotent.",
		FailClosedUnpublished: true,
		FailClosedDisabled:    true,
		IdempotencyKeyPattern: `^sched-[0-9a-f-]{36}-[0-9]{1,16}$`,
		DispatchRoute:         "POST /api/v1/schedules/dispatch",
		Permission:            "workflow.edit",
		ViewPermission:        "workflow.view",
		DispatchPermission:    "workflow.execute",
		CSRF:                  true,
		Help:                  "Admin CRUD pins a published workflow version. Timezone is a required IANA name. Safe defaults: skip overlap, ignore misfires, catchUp=0. Dispatcher starts with E10.1 idempotency/authz/policy and fails closed when the schedule or published version is disabled.",
	}
}

// Store persists schedules under server-derived workspace scope.
type Store interface {
	Create(ctx context.Context, scope isolation.Scope, now time.Time, in CreateInput) (Record, error)
	List(ctx context.Context, scope isolation.Scope, workflowID string) ([]Record, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Record, error)
	Update(ctx context.Context, scope isolation.Scope, now time.Time, id string, in UpdateInput) (Record, error)
	SetStatus(ctx context.Context, scope isolation.Scope, now time.Time, id, status string) (Record, error)
	Delete(ctx context.Context, scope isolation.Scope, id string) error
	ListDue(ctx context.Context, scope isolation.Scope, now time.Time) ([]Record, error)
	RecordFire(ctx context.Context, scope isolation.Scope, now time.Time, id string, in FireUpdate) (Record, error)
}

// IdempotencyKey is unique per schedule fire slot.
func IdempotencyKey(scheduleID string, fireAt time.Time) string {
	return fmt.Sprintf("sched-%s-%d", strings.TrimSpace(scheduleID), fireAt.UTC().Unix())
}

func normalizeCreate(scope isolation.Scope, in CreateInput, now time.Time) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if !authz.ValidUUID(in.WorkflowID) || !authz.ValidUUID(in.WorkflowVersionID) {
		return Record{}, ErrUnpublished
	}
	rec := Record{
		ID:                newID(),
		WorkflowID:        strings.TrimSpace(in.WorkflowID),
		WorkflowVersionID: strings.TrimSpace(in.WorkflowVersionID),
		WorkflowDigest:    strings.TrimSpace(in.WorkflowDigest),
		TriggerID:         strings.TrimSpace(in.TriggerID),
		Timezone:          strings.TrimSpace(in.Timezone),
		Cron:              strings.TrimSpace(in.Cron),
		Interval:          strings.TrimSpace(in.Interval),
		OverlapPolicy:     firstNonEmpty(strings.TrimSpace(in.OverlapPolicy), DefaultOverlap),
		MisfirePolicy:     firstNonEmpty(strings.TrimSpace(in.MisfirePolicy), DefaultMisfire),
		CatchUp:           DefaultCatchUp,
		Status:            StatusEnabled,
		CreatedBy:         scope.ActorID(),
		UpdatedBy:         scope.ActorID(),
		CreatedAt:         now.UTC(),
		UpdatedAt:         now.UTC(),
	}
	if in.CatchUp != nil {
		rec.CatchUp = *in.CatchUp
	}
	if err := validateRecord(rec); err != nil {
		return Record{}, err
	}
	next, err := NextAfter(rec, now.UTC())
	if err != nil {
		return Record{}, err
	}
	rec.NextFireAt = next
	return rec, nil
}

func applyUpdate(rec Record, in UpdateInput, actor string, now time.Time) (Record, error) {
	if in.WorkflowVersionID != nil {
		id := strings.TrimSpace(*in.WorkflowVersionID)
		if !authz.ValidUUID(id) {
			return Record{}, ErrUnpublished
		}
		rec.WorkflowVersionID = id
	}
	if in.WorkflowDigest != nil {
		rec.WorkflowDigest = strings.TrimSpace(*in.WorkflowDigest)
	}
	if in.TriggerID != nil {
		rec.TriggerID = strings.TrimSpace(*in.TriggerID)
	}
	if in.Timezone != nil {
		rec.Timezone = strings.TrimSpace(*in.Timezone)
	}
	if in.Cron != nil {
		rec.Cron = strings.TrimSpace(*in.Cron)
		if rec.Cron != "" {
			rec.Interval = ""
		}
	}
	if in.Interval != nil {
		rec.Interval = strings.TrimSpace(*in.Interval)
		if rec.Interval != "" {
			rec.Cron = ""
		}
	}
	if in.OverlapPolicy != nil {
		rec.OverlapPolicy = firstNonEmpty(strings.TrimSpace(*in.OverlapPolicy), DefaultOverlap)
	}
	if in.MisfirePolicy != nil {
		rec.MisfirePolicy = firstNonEmpty(strings.TrimSpace(*in.MisfirePolicy), DefaultMisfire)
	}
	if in.CatchUp != nil {
		rec.CatchUp = *in.CatchUp
	}
	rec.UpdatedBy = actor
	rec.UpdatedAt = now.UTC()
	if err := validateRecord(rec); err != nil {
		return Record{}, err
	}
	next, err := NextAfter(rec, now.UTC())
	if err != nil {
		return Record{}, err
	}
	rec.NextFireAt = next
	return rec, nil
}

func validateRecord(rec Record) error {
	if strings.TrimSpace(rec.Timezone) == "" {
		return ErrTimezone
	}
	if _, err := LoadLocation(rec.Timezone); err != nil {
		return ErrTimezone
	}
	hasCron := rec.Cron != ""
	hasInterval := rec.Interval != ""
	if hasCron == hasInterval {
		return ErrInvalid
	}
	if hasCron {
		if _, err := parseCron(rec.Cron); err != nil {
			return ErrInvalid
		}
	}
	if hasInterval {
		d, err := workflow.ParseISODuration(rec.Interval)
		if err != nil || d <= 0 || d > time.Duration(workflow.MaxDelaySeconds)*time.Second {
			return ErrInvalid
		}
	}
	if !oneOf(rec.OverlapPolicy, OverlapSkip, OverlapReject, OverlapQueue) {
		return ErrInvalid
	}
	if !oneOf(rec.MisfirePolicy, MisfireIgnore, MisfireFireOnce) {
		return ErrInvalid
	}
	if rec.CatchUp < 0 || rec.CatchUp > MaxCatchUp {
		return ErrInvalid
	}
	return nil
}

func oneOf(got string, allow ...string) bool {
	for _, a := range allow {
		if got == a {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func cloneRecord(in Record) Record {
	if in.LastFiredAt != nil {
		t := *in.LastFiredAt
		in.LastFiredAt = &t
	}
	return in
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
