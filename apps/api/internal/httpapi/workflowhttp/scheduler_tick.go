package workflowhttp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/approvalhttp"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TickDispatch(s *core.Server, ctx context.Context) error {
	now := Now(s)
	ctx = schedulerContext(ctx, now)
	var started, skipped int
	err := eachActiveWorkspace(s, ctx, func(scope isolation.Scope) error {
		items, err := dispatchDue(s, ctx, scope, now, "")
		if err != nil {
			return err
		}
		for _, item := range items {
			if item.ExecutionID != "" && item.SkipReason != "replayed" {
				started++
				continue
			}
			skipped++
		}
		return nil
	})
	if s.Log != nil {
		s.Log.Info("scheduler dispatch", "started", started, "skipped", skipped)
	}
	return err
}

func TickRecover(s *core.Server, ctx context.Context) error {
	now := Now(s)
	ctx = schedulerContext(ctx, now)
	var recovered int
	err := eachActiveWorkspace(s, ctx, func(scope isolation.Scope) error {
		n, err := recoverWorkspace(s, ctx, scope)
		recovered += n
		return err
	})
	if s.Log != nil {
		s.Log.Info("scheduler recover", "recovered", recovered)
	}
	return err
}

func TickPurge(s *core.Server, ctx context.Context) error {
	now := Now(s)
	ctx = schedulerContext(ctx, now)
	var purged, held, execs, audits int
	err := eachActiveWorkspace(s, ctx, func(scope isolation.Scope) error {
		out, err := purgeWorkspace(s, ctx, scope, now)
		purged += out.Purged
		held += out.Held
		execs += out.Executions
		audits += out.Audits
		return err
	})
	if s.Log != nil {
		s.Log.Info("scheduler purge", "purged", purged, "held", held, "executions", execs, "audits", audits)
	}
	return err
}

func recoverWorkspace(s *core.Server, ctx context.Context, scope isolation.Scope) (int, error) {
	if s.Workflows == nil {
		return 0, wfstore.ErrStoreUnavailable
	}
	n, err := s.Workflows.RecoverExpiredLeases(ctx, scope, Now(s))
	if err != nil {
		return 0, err
	}
	approvalhttp.SyncWaitingApprovals(s, ctx, scope)
	return n, nil
}

func eachActiveWorkspace(s *core.Server, ctx context.Context, fn func(isolation.Scope) error) error {
	if s.Store == nil {
		return identity.ErrStoreUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	items, err := s.Store.ListActiveWorkspaces(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, ws := range items {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		if !strings.EqualFold(strings.TrimSpace(ws.Status), "active") {
			continue
		}
		scope, err := isolation.AuthorizeTenancy(ws.ID, "", ws.TenantID, ws.WorkbenchKey)
		if err != nil {
			errs = append(errs, fmt.Errorf("workspace %s: %w", ws.ID, err))
			continue
		}
		if err := fn(scope); err != nil {
			errs = append(errs, fmt.Errorf("workspace %s: %w", ws.ID, err))
		}
	}
	return errors.Join(errs...)
}

func schedulerContext(ctx context.Context, now time.Time) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if core.RequestIDFromContext(ctx) != "" {
		return ctx
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	id := fmt.Sprintf("sched-%d", now.UnixNano())
	if !core.ValidRequestID(id) {
		id = core.GenerateRequestID()
	}
	return context.WithValue(ctx, core.RequestIDKey, id)
}
