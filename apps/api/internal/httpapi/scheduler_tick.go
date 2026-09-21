package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// API is the control-plane handler plus the leader-scheduler hooks.
// cmd/api type-asserts this so one process can tick without an external cron.
type API struct {
	http.Handler
	srv *Server
}

// TickDispatch fires due published schedules in every active workspace.
func (a *API) TickDispatch(ctx context.Context) error {
	if a == nil || a.srv == nil {
		return errors.New("scheduler api is not configured")
	}
	return a.srv.tickDispatch(ctx)
}

// TickRecover marks expired leases indeterminate under the existing fence.
func (a *API) TickRecover(ctx context.Context) error {
	if a == nil || a.srv == nil {
		return errors.New("scheduler api is not configured")
	}
	return a.srv.tickRecover(ctx)
}

// TickPurge deletes expired artifact payloads and execution/audit rows.
func (a *API) TickPurge(ctx context.Context) error {
	if a == nil || a.srv == nil {
		return errors.New("scheduler api is not configured")
	}
	return a.srv.tickPurge(ctx)
}

func (s *Server) tickDispatch(ctx context.Context) error {
	now := s.now()
	ctx = schedulerContext(ctx, now)
	var started, skipped int
	err := s.eachActiveWorkspace(ctx, func(scope isolation.Scope) error {
		items, err := s.dispatchDue(ctx, scope, now, "")
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
	if s.log != nil {
		s.log.Info("scheduler dispatch", "started", started, "skipped", skipped)
	}
	return err
}

func (s *Server) tickRecover(ctx context.Context) error {
	now := s.now()
	ctx = schedulerContext(ctx, now)
	var recovered int
	err := s.eachActiveWorkspace(ctx, func(scope isolation.Scope) error {
		n, err := s.recoverWorkspace(ctx, scope)
		recovered += n
		return err
	})
	if s.log != nil {
		s.log.Info("scheduler recover", "recovered", recovered)
	}
	return err
}

func (s *Server) tickPurge(ctx context.Context) error {
	now := s.now()
	ctx = schedulerContext(ctx, now)
	var purged, held, execs, audits int
	err := s.eachActiveWorkspace(ctx, func(scope isolation.Scope) error {
		out, err := s.purgeWorkspace(ctx, scope, now)
		purged += out.Purged
		held += out.Held
		execs += out.Executions
		audits += out.Audits
		return err
	})
	if s.log != nil {
		s.log.Info("scheduler purge", "purged", purged, "held", held, "executions", execs, "audits", audits)
	}
	return err
}

func (s *Server) recoverWorkspace(ctx context.Context, scope isolation.Scope) (int, error) {
	if s.workflows == nil {
		return 0, wfstore.ErrStoreUnavailable
	}
	n, err := s.workflows.RecoverExpiredLeases(ctx, scope, s.now())
	if err != nil {
		return 0, err
	}
	s.syncWaitingApprovals(ctx, scope)
	return n, nil
}

func (s *Server) eachActiveWorkspace(ctx context.Context, fn func(isolation.Scope) error) error {
	if s.store == nil {
		return identity.ErrStoreUnavailable
	}
	items, err := s.store.ListActiveWorkspaces(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, ws := range items {
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
	if RequestIDFromContext(ctx) != "" {
		return ctx
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	id := fmt.Sprintf("sched-%d", now.UnixNano())
	if !validRequestID(id) {
		id = generateRequestID()
	}
	return context.WithValue(ctx, requestIDKey, id)
}
