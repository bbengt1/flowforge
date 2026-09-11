// Local/dev compose worker. Claims POST /api/v1/jobs/claim with the same
// lease + HMAC ticket + fencing contract as production workers.
// Production-locked APP_ENV or REQUIRE_TLS refuses to start.
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
	"github.com/bbengt1/flowforge/apps/api/internal/localworker"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func main() {
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	slog.SetDefault(log)

	appEnv := firstNonEmpty(os.Getenv(authz.EnvAppEnv), os.Getenv(authz.EnvFlowforgeEnv))
	requireTLS := truthy(os.Getenv(authz.EnvRequireTLS))
	enabled, err := localworker.Resolve(os.Getenv(localworker.EnvLocalWorker), appEnv, requireTLS)
	if err != nil {
		log.Error("local worker misconfigured", "error", err)
		os.Exit(1)
	}
	if !enabled {
		if authz.ProductionLocked(appEnv, requireTLS) {
			log.Error("local worker refused to start in a production-locked environment")
			os.Exit(1)
		}
		log.Info("local worker opted out")
		os.Exit(0)
	}

	issuer, subject := workerIdentity()
	if issuer == "" || subject == "" {
		log.Error("local worker identity is required (WORKER_ISSUER/WORKER_SUBJECT or PLATFORM_ADMINS)")
		os.Exit(1)
	}

	baseURL := strings.TrimSpace(os.Getenv("API_URL"))
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8080"
	}
	workerID := strings.TrimSpace(os.Getenv("WORKER_ID"))
	if workerID == "" {
		workerID = "compose-local"
	}

	client := localworker.NewHTTP(localworker.HTTPConfig{
		BaseURL:  baseURL,
		Issuer:   issuer,
		Subject:  subject,
		WorkerID: workerID,
		Lease:    durationEnv("WORKER_LEASE", 30*time.Second),
	})
	runner := localworker.NewRunner(client, localworker.Config{
		WorkerID:     workerID,
		PollInterval: durationEnv("WORKER_POLL_INTERVAL", time.Second),
		Log:          log,
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info("local worker starting", "api_url", baseURL, "worker_id", workerID, "app_env", appEnv)
	if err := runner.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("local worker stopped", "error", err)
		os.Exit(1)
	}
}

func workerIdentity() (string, string) {
	issuer := strings.TrimSpace(os.Getenv("WORKER_ISSUER"))
	subject := strings.TrimSpace(os.Getenv("WORKER_SUBJECT"))
	if issuer != "" && subject != "" {
		return issuer, subject
	}
	admins := authz.ParsePlatformAdmins(os.Getenv(authz.EnvPlatformAdmins), os.Getenv(authz.EnvPlatformAdmin))
	if len(admins) == 0 {
		return issuer, subject
	}
	if issuer == "" {
		issuer = admins[0].Issuer
	}
	if subject == "" {
		subject = admins[0].Subject
	}
	return issuer, subject
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
			return v
		}
	}
	return ""
}
