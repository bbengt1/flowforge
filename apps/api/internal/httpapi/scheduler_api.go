package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/workflowhttp"
)

// API is the control-plane handler plus the leader-scheduler hooks.
// cmd/api type-asserts this so one process can tick without an external cron.
type API struct {
	http.Handler
	srv        *core.Server
	replicaErr error
	// unshared names process-local durable backends. Production boot
	// refuses the list. Replica boot refuses it above one replica.
	unshared []string
}

// TickDispatch fires due published schedules in every active workspace.
func (a *API) TickDispatch(ctx context.Context) error {
	if a == nil || a.srv == nil {
		return errors.New("scheduler api is not configured")
	}
	return workflowhttp.TickDispatch(a.srv, ctx)
}

// TickRecover marks expired leases indeterminate under the existing fence.
func (a *API) TickRecover(ctx context.Context) error {
	if a == nil || a.srv == nil {
		return errors.New("scheduler api is not configured")
	}
	return workflowhttp.TickRecover(a.srv, ctx)
}

// TickPurge deletes expired artifact payloads and execution/audit rows.
func (a *API) TickPurge(ctx context.Context) error {
	if a == nil || a.srv == nil {
		return errors.New("scheduler api is not configured")
	}
	return workflowhttp.TickPurge(a.srv, ctx)
}
