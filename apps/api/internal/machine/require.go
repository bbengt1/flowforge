package machine

import (
	"context"
	"fmt"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Consumer names for MACHINE_REQUIRE.
const (
	ConsumerMetrics    = "metrics"
	ConsumerScheduler  = "scheduler"
	ConsumerAutomation = "automation"

	EnvRequire            = "MACHINE_REQUIRE"
	EnvMetricsClientID    = "MACHINE_METRICS_CLIENT_ID"
	EnvSchedulerClientID  = "MACHINE_SCHEDULER_CLIENT_ID"
	EnvAutomationClientID = "MACHINE_AUTOMATION_CLIENT_ID"
)

// Consumers is the opt-in set of automation callers that must have a
// live principal. Empty Require does not change existing boots.
type Consumers struct {
	Require            []string
	MetricsClientID    string
	SchedulerClientID  string
	AutomationClientID string
}

// ParseConsumers reads MACHINE_REQUIRE and the per-consumer client ids.
// A required consumer with a missing or invalid client id fails closed.
// Client ids that are set are validated even when that consumer is not
// required, so a typo is a boot-fail.
func ParseConsumers(require, metricsID, schedulerID, automationID string) (Consumers, error) {
	metricsID, err := optionalClientID(metricsID)
	if err != nil {
		return Consumers{}, fmt.Errorf("%s: %w", EnvMetricsClientID, ErrInvalid)
	}
	schedulerID, err = optionalClientID(schedulerID)
	if err != nil {
		return Consumers{}, fmt.Errorf("%s: %w", EnvSchedulerClientID, ErrInvalid)
	}
	automationID, err = optionalClientID(automationID)
	if err != nil {
		return Consumers{}, fmt.Errorf("%s: %w", EnvAutomationClientID, ErrInvalid)
	}
	var names []string
	seen := map[string]struct{}{}
	for _, part := range strings.Split(require, ",") {
		name := strings.ToLower(strings.TrimSpace(part))
		if name == "" {
			continue
		}
		switch name {
		case ConsumerMetrics, ConsumerScheduler, ConsumerAutomation:
		default:
			return Consumers{}, fmt.Errorf("%s: %w", EnvRequire, ErrInvalid)
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	c := Consumers{
		Require:            names,
		MetricsClientID:    metricsID,
		SchedulerClientID:  schedulerID,
		AutomationClientID: automationID,
	}
	for _, name := range names {
		if c.ClientID(name) == "" {
			return Consumers{}, fmt.Errorf("%w: consumer %s", ErrMisconfigured, name)
		}
	}
	return c, nil
}

func optionalClientID(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	return NormalizeClientID(raw)
}

// Requires reports whether name is in MACHINE_REQUIRE.
func (c Consumers) Requires(name string) bool {
	name = strings.TrimSpace(name)
	for _, item := range c.Require {
		if item == name {
			return true
		}
	}
	return false
}

// ClientID returns the configured public client id for a consumer.
func (c Consumers) ClientID(name string) string {
	switch strings.TrimSpace(name) {
	case ConsumerMetrics:
		return c.MetricsClientID
	case ConsumerScheduler:
		return c.SchedulerClientID
	case ConsumerAutomation:
		return c.AutomationClientID
	default:
		return ""
	}
}

// CheckConsumer fails closed when name is required and its principal
// is missing, revoked, or missing the minimum grant. A consumer that
// is not required returns nil.
func CheckConsumer(ctx context.Context, store Store, c Consumers, name string) error {
	if !c.Requires(name) {
		return nil
	}
	id := c.ClientID(name)
	if id == "" || store == nil {
		return fmt.Errorf("%w: consumer %s", ErrMisconfigured, name)
	}
	p, err := store.GetByClientID(ctx, id)
	if err != nil {
		return fmt.Errorf("%w: consumer %s client_id %s", ErrMisconfigured, name, id)
	}
	if p.Status != StatusActive {
		return fmt.Errorf("%w: consumer %s client_id %s", ErrMisconfigured, name, id)
	}
	if !satisfied(name, p.Grants) {
		return fmt.Errorf("%w: consumer %s client_id %s", ErrMisconfigured, name, id)
	}
	return nil
}

// Gate runs next only when the required consumer is healthy.
func Gate(ctx context.Context, store Store, c Consumers, name string, next func(context.Context) error) error {
	if err := CheckConsumer(ctx, store, c, name); err != nil {
		return err
	}
	if next == nil {
		return nil
	}
	return next(ctx)
}

func satisfied(name string, grants []string) bool {
	switch name {
	case ConsumerMetrics:
		return authz.Allows(grants, authz.PermOpsMetricsRead) || authz.Allows(grants, authz.PermPlatformAdminister)
	case ConsumerScheduler:
		return authz.Allows(grants, authz.PermWorkflowExecute)
	case ConsumerAutomation:
		for _, g := range grants {
			if Grantable(g) {
				return true
			}
		}
		return false
	default:
		return false
	}
}
