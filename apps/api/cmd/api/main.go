package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/config"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func main() {
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	slog.SetDefault(log)

	cfg, err := config.Load()
	if err != nil {
		log.Error("load config", "error", err)
		os.Exit(1)
	}

	pool := postgres.NewPool(cfg.DatabaseURL, log, cfg.MigrateTimeout)
	bg, stopBG := context.WithCancel(context.Background())
	go pool.Start(bg)
	defer func() {
		stopBG()
		pool.Close()
	}()

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: httpapi.NewWithSecurity(pool, httpapi.Security{
			TrustedProxies: cfg.TrustedProxies,
			RequireTLS:     cfg.RequireTLS,
			AllowedOrigins: cfg.CORSAllowedOrigins,
			Session: httpapi.SessionPolicy{
				IdleTimeout:     cfg.SessionIdleTimeout,
				AbsoluteTimeout: cfg.SessionAbsoluteTimeout,
			},
			VaultKeys: cfg.VaultKeys,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if cfg.TLSCertFile != "" {
			log.Info("api listening", "addr", cfg.HTTPAddr, "tls", true, "require_tls", cfg.RequireTLS)
			errCh <- srv.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile)
			return
		}
		log.Info("api listening", "addr", cfg.HTTPAddr, "tls", false, "require_tls", cfg.RequireTLS)
		errCh <- srv.ListenAndServe()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen", "error", err)
			os.Exit(1)
		}
	case sig := <-sigCh:
		log.Info("shutting down", "signal", sig.String())
	}

	timeout := cfg.ShutdownWait
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("shutdown", "error", err)
		os.Exit(1)
	}
}
