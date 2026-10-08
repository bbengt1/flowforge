package localseed

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/jackc/pgx/v5/pgxpool"
)

// WorkerInput configures the compose worker binding.
type WorkerInput struct {
	Store identity.Store
	// Worker is the principal the compose worker presents.
	Worker authz.PrincipalRef
	// Humans are principals that must never be rebound as the worker:
	// PLATFORM_ADMINS and the first-run local admin.
	Humans []authz.PrincipalRef
	Log    *slog.Logger
}

// WorkerResult is a secret-free summary.
type WorkerResult struct {
	UserID  string
	Changed bool
	Skipped string
}

// WorkerHook binds the compose worker in the local workbench after
// readiness. Dev only: the caller wires it only when
// localworker.BindingEnabled is true.
func WorkerHook(in WorkerInput) func(context.Context, *pgxpool.Pool) error {
	return func(ctx context.Context, db *pgxpool.Pool) error {
		if db == nil {
			return fmt.Errorf("local worker binding: postgres pool is nil")
		}
		in.Store = identity.NewPostgres(db)
		log := logger(in.Log)
		res, err := EnsureWorker(ctx, in)
		if err != nil {
			// A dev convenience: the API stays up; only local claims wait.
			log.Error("local worker binding failed", "error", err)
			return nil
		}
		if res.Skipped != "" {
			log.Warn("local worker binding skipped", "reason", res.Skipped)
			return nil
		}
		log.Info("local worker bound",
			"tenant_slug", TenantSlug,
			"workbench_key", WorkbenchKey,
			"role", localworker.WorkerRole,
			"changed", res.Changed,
		)
		return nil
	}
}

// EnsureWorker binds the worker principal in the local tenant's default
// workbench with exactly localworker.WorkerRole. Idempotent. Any other
// role on that principal there is removed, so the worker is never an
// admin, an approver candidate, or an eligible decider. A missing local
// workbench is skipped, not created: creating one would make the worker
// its admin. A principal that is a human admin (PLATFORM_ADMINS or the
// first-run local admin) is skipped and left untouched.
func EnsureWorker(ctx context.Context, in WorkerInput) (WorkerResult, error) {
	return EnsureWorkerIn(ctx, in, TenantSlug, WorkbenchKey)
}

// EnsureWorkerIn is EnsureWorker for an explicit tenant slug and
// workbench key. Tests use it; startup uses EnsureWorker.
func EnsureWorkerIn(ctx context.Context, in WorkerInput, tenantSlug, workbenchKey string) (WorkerResult, error) {
	if in.Store == nil {
		return WorkerResult{}, fmt.Errorf("local worker binding: identity store is required")
	}
	issuer := strings.TrimSpace(in.Worker.Issuer)
	subject := strings.TrimSpace(in.Worker.Subject)
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		return WorkerResult{Skipped: "worker principal is not valid"}, nil
	}
	humans := append([]authz.PrincipalRef{{Issuer: BootstrapIssuer, Subject: BootstrapSubject}}, in.Humans...)
	for _, h := range humans {
		if strings.TrimSpace(h.Issuer) == issuer && strings.TrimSpace(h.Subject) == subject {
			return WorkerResult{Skipped: "worker principal is a human admin; set WORKER_ISSUER/WORKER_SUBJECT to a dedicated principal"}, nil
		}
	}
	tenant, err := in.Store.GetTenantBySlug(ctx, tenantSlug)
	if errors.Is(err, identity.ErrNotFound) {
		return WorkerResult{Skipped: "local tenant does not exist yet"}, nil
	}
	if err != nil {
		return WorkerResult{}, err
	}
	ws, _, err := in.Store.ResolveWorkspace(ctx, tenant.ID, tenant.Slug, workbenchKey)
	if errors.Is(err, identity.ErrNotFound) {
		return WorkerResult{Skipped: "local workbench does not exist yet"}, nil
	}
	if err != nil {
		return WorkerResult{}, err
	}
	user, err := in.Store.UpsertUser(ctx, issuer, subject, localworker.DisplayName)
	if err != nil {
		return WorkerResult{}, err
	}
	res := WorkerResult{UserID: user.ID}
	if user.Status != "active" {
		return WorkerResult{UserID: user.ID, Skipped: "worker principal is disabled"}, nil
	}
	roles, _, err := in.Store.EffectiveAccess(ctx, ws.ID, user.ID)
	if err != nil && !errors.Is(err, identity.ErrNotFound) {
		return WorkerResult{}, err
	}
	want := []string{localworker.WorkerRole}
	if !slices.Equal(roles, want) {
		if err := in.Store.SetMemberRoles(ctx, ws.ID, user.ID, want); err != nil {
			return WorkerResult{}, err
		}
		res.Changed = true
	}
	roles, perms, err := in.Store.EffectiveAccess(ctx, ws.ID, user.ID)
	if err != nil {
		return WorkerResult{}, err
	}
	if !slices.Equal(roles, want) || !authz.Allows(perms, authz.PermWorkflowExecute) ||
		authz.Allows(perms, authz.PermApprovalDecide) || authz.Allows(perms, authz.PermWorkspaceAdminister) {
		return WorkerResult{}, fmt.Errorf("local worker binding: stored roles %v do not match %s", roles, localworker.WorkerRole)
	}
	return res, nil
}
