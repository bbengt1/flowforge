// Production-locked worker. Claims jobs in-process (FORCE RLS via the
// app pool) and dispatches to the kubernetes, ssh, script, and http
// engines. Local/dev compose keeps cmd/worker; this process refuses
// that path.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/config"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/runner"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func main() {
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	slog.SetDefault(log)

	appEnv := firstNonEmpty(os.Getenv(authz.EnvAppEnv), os.Getenv(authz.EnvFlowforgeEnv))
	requireTLS := truthy(os.Getenv(authz.EnvRequireTLS))
	enabled, err := runner.Resolve(os.Getenv(runner.EnvRunner), appEnv, requireTLS)
	if err != nil {
		log.Error("production runner refused the local/dev path", "error", err)
		os.Exit(1)
	}
	if !enabled {
		log.Info("production runner opted out")
		os.Exit(0)
	}

	cfg, err := config.Load()
	if err != nil {
		log.Error("runner configuration is invalid")
		os.Exit(1)
	}
	if !cfg.VaultKeys.Ready() {
		log.Error("runner cannot unlock credentials")
		os.Exit(1)
	}

	userID, issuer, subject := runnerIdentity()
	if userID == "" && (issuer == "" || subject == "") {
		log.Error("production runner identity is required (RUNNER_USER_ID or RUNNER_ISSUER/RUNNER_SUBJECT or PLATFORM_ADMINS)")
		os.Exit(1)
	}
	workerID := strings.TrimSpace(os.Getenv("WORKER_ID"))
	if workerID == "" {
		workerID = "production-runner"
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool := postgres.NewPool(cfg.DatabaseURL, log, cfg.MigrateTimeout)
	go pool.Start(ctx)
	if err := waitReady(ctx, pool); err != nil {
		log.Error("production runner stopped before postgres was ready")
		os.Exit(1)
	}

	integration := cfg.IntegrationActionsEnabled
	queue := &runner.StoreQueue{
		Workflows: wfstore.NewPostgres(pool),
		Identity:  identity.NewPostgres(pool),
		JobKey:    cfg.JobBindingKey,
		WorkerID:  workerID,
		UserID:    userID,
		Issuer:    issuer,
		Subject:   subject,
		Lease:     durationEnv("WORKER_LEASE", 30*time.Second),
	}
	disp := &runner.Dispatcher{
		Ops:                opsconfig.NewPostgres(pool),
		Vault:              vault.NewPostgres(pool, cfg.VaultKeys, nil),
		Scripts:            scripts.NewPostgres(pool),
		ScriptKey:          cfg.ScriptSigningKey,
		IntegrationEnabled: &integration,
	}
	loop := runner.NewRunner(queue, disp, runner.Config{
		WorkerID:     workerID,
		PollInterval: durationEnv("WORKER_POLL_INTERVAL", time.Second),
		Log:          log,
	})

	log.Info("production runner starting", "worker_id", workerID, "app_env", appEnv)
	if err := loop.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("production runner stopped", "error", err)
		os.Exit(1)
	}
}

func waitReady(ctx context.Context, pool *postgres.Pool) error {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := pool.Ping(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func runnerIdentity() (userID, issuer, subject string) {
	userID = strings.TrimSpace(os.Getenv("RUNNER_USER_ID"))
	issuer = strings.TrimSpace(os.Getenv("RUNNER_ISSUER"))
	subject = strings.TrimSpace(os.Getenv("RUNNER_SUBJECT"))
	if userID != "" || (issuer != "" && subject != "") {
		return userID, issuer, subject
	}
	admins := authz.ParsePlatformAdmins(os.Getenv(authz.EnvPlatformAdmins), os.Getenv(authz.EnvPlatformAdmin))
	if len(admins) == 0 {
		return userID, issuer, subject
	}
	return "", admins[0].Issuer, admins[0].Subject
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

func truthy(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
