package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
	"github.com/bbengt1/flowforge/apps/api/internal/buildinfo"
	"github.com/bbengt1/flowforge/apps/api/internal/config"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/tlsmaterial"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	slog.SetDefault(log)

	cfg, err := config.Load()
	if err != nil {
		log.Error("load config", "error", err)
		os.Exit(1)
	}
	ident := buildinfo.Resolve()
	log.Info("build identity", "version", ident.Version, "sha", ident.SHA)

	pool := postgres.NewPool(cfg.DatabaseURL, log, cfg.MigrateTimeout)
	bootstrapLogin := localseed.BootstrapLoginHook(log)
	if cfg.SeedLocalDefaults {
		localDefaults := localseed.Hook(localseed.Input{
			Keys:           cfg.VaultKeys,
			PlatformAdmins: cfg.PlatformAdmins,
			PublicBaseURL:  cfg.PublicBaseURL,
			Log:            log,
		})
		pool.SetAfterReady(func(ctx context.Context, db *pgxpool.Pool) error {
			if err := localDefaults(ctx, db); err != nil {
				return err
			}
			return bootstrapLogin(ctx, db)
		})
	} else {
		pool.SetAfterReady(bootstrapLogin)
	}
	bg, stopBG := context.WithCancel(context.Background())
	go pool.Start(bg)
	defer func() {
		stopBG()
		pool.Close()
	}()

	objects, _, err := loadArtifactObjects(cfg.ArtifactStoreDir)
	if err != nil {
		log.Error("artifact store", "error", err)
		os.Exit(1)
	}

	tlsMaterials, err := loadTLSMaterials(cfg.TLSCertFile, cfg.TLSKeyFile)
	if err != nil {
		log.Error("tls material store", "error", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: httpapi.NewWithDeps(httpapi.Deps{
			DB:                   pool,
			Keys:                 cfg.VaultKeys,
			JobBindingKey:        cfg.JobBindingKey,
			ScriptSigningKey:     cfg.ScriptSigningKey,
			Objects:              objects,
			TLSMaterials:         tlsMaterials,
			DownloadTTL:          cfg.ArtifactDownloadTTL,
			ArtifactMaxBytes:     cfg.ArtifactMaxBytes,
			EmbedKeys:            cfg.EmbedKeys,
			EmbedIssuers:         cfg.EmbedIssuers,
			PortalIssuers:        cfg.PortalIssuers,
			PortalFrameAncestors: cfg.PortalFrameAncestors,
			PlatformAdmins:       cfg.PlatformAdmins,
			EmbedLimits:          cfg.EmbedLimits,
			LoginLimits:          cfg.LoginLimits,
			EmbedNBFLeeway:       cfg.EmbedNBFLeeway,
			Security: httpapi.Security{
				TrustedProxies:       cfg.TrustedProxies,
				RequireTLS:           cfg.RequireTLS,
				AllowedOrigins:       cfg.CORSAllowedOrigins,
				TrustIdentityHeaders: cfg.TrustIdentityHeaders,
				Session: httpapi.SessionPolicy{
					IdleTimeout:     cfg.SessionIdleTimeout,
					AbsoluteTimeout: cfg.SessionAbsoluteTimeout,
				},
				VaultKeys:     cfg.VaultKeys,
				JobBindingKey: cfg.JobBindingKey,
			},
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	if cfg.TrustIdentityHeaders {
		log.Warn("trusted_dev_identity_headers enabled; self-asserted X-FlowForge-Issuer/Subject are accepted")
	}
	if cfg.SeedLocalDefaults {
		log.Info("local defaults seed enabled; tenant/workbench and demo credentials will be written after migrate")
	}

	errCh := make(chan error, 1)
	go func() {
		// TLS_* may be set as B.5 write destinations before any PEM
		// exists (compose /tmp defaults). ListenAndServeTLS only when
		// both files are already on disk; otherwise stay HTTP. A
		// restart is required to pick up newly written materials.
		if shouldListenTLS(cfg.TLSCertFile, cfg.TLSKeyFile) {
			log.Info("api listening", "addr", cfg.HTTPAddr, "tls", true, "require_tls", cfg.RequireTLS, "trust_identity_headers", cfg.TrustIdentityHeaders)
			errCh <- srv.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile)
			return
		}
		log.Info("api listening", "addr", cfg.HTTPAddr, "tls", false, "require_tls", cfg.RequireTLS, "trust_identity_headers", cfg.TrustIdentityHeaders)
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

func loadTLSMaterials(certPath, keyPath string) (tlsmaterial.Store, error) {
	certPath = strings.TrimSpace(certPath)
	keyPath = strings.TrimSpace(keyPath)
	if certPath == "" && keyPath == "" {
		return nil, nil
	}
	return tlsmaterial.NewFiles(certPath, keyPath)
}

// shouldListenTLS is true only when both process TLS files already
// exist. Configured-but-missing paths stay HTTP so first-run B.5 can
// write them (compose /tmp defaults) without a boot-fail.
func shouldListenTLS(certPath, keyPath string) bool {
	certPath = strings.TrimSpace(certPath)
	keyPath = strings.TrimSpace(keyPath)
	if certPath == "" || keyPath == "" {
		return false
	}
	if _, err := os.Stat(certPath); err != nil {
		return false
	}
	if _, err := os.Stat(keyPath); err != nil {
		return false
	}
	return true
}

func loadArtifactObjects(root string) (artifact.Objects, string, error) {
	if strings.TrimSpace(root) == "" {
		return artifact.NewMemoryObjects(), "memory", nil
	}
	fs, err := artifact.NewFilesystemObjects(root)
	if err != nil {
		return nil, "", err
	}
	return fs, root, nil
}
