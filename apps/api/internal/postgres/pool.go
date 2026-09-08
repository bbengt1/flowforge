package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrUnavailable is returned when PostgreSQL is not reachable.
var ErrUnavailable = errors.New("postgresql is not reachable")

// Checker reports whether the database dependency is available.
type Checker interface {
	Ping(ctx context.Context) error
}

const (
	defaultConnectTimeout = 5 * time.Second
	defaultMigrateTimeout = 5 * time.Minute
)

// Pool is a reconnecting PostgreSQL pool used by readiness and migrations.
type Pool struct {
	url            string
	log            *slog.Logger
	migrateTimeout time.Duration
	mu             sync.RWMutex
	pool           *pgxpool.Pool
	last           error
}

// NewPool returns an unconnected pool. Call Start to connect and migrate.
// migrateTimeout bounds schema application after a successful ping; a
// non-positive value uses 5 minutes. Connect/ping stay on a 5s deadline.
func NewPool(databaseURL string, log *slog.Logger, migrateTimeout time.Duration) *Pool {
	if log == nil {
		log = slog.Default()
	}
	if migrateTimeout <= 0 {
		migrateTimeout = defaultMigrateTimeout
	}
	return &Pool{url: databaseURL, log: log, migrateTimeout: migrateTimeout, last: ErrUnavailable}
}

// Start connects, applies forward-only migrations, and retries until ctx ends.
func (p *Pool) Start(ctx context.Context) {
	if p.url == "" {
		p.mu.Lock()
		p.last = fmt.Errorf("%w: DATABASE_URL is not set", ErrUnavailable)
		p.mu.Unlock()
		p.log.Error("postgres is not configured; readiness will fail")
		return
	}
	if _, err := pgxpool.ParseConfig(p.url); err != nil {
		p.setErr(fmt.Errorf("parse database url: %w", err))
		p.log.Error("invalid DATABASE_URL; readiness will fail")
		return
	}

	backoff := time.Second
	for {
		err := p.connectAndMigrate(ctx)
		if err == nil {
			return
		}
		if ctx.Err() != nil {
			return
		}
		p.log.Warn("postgres not ready; retrying", "error", err, "backoff", backoff.String())
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 15*time.Second {
			backoff *= 2
			if backoff > 15*time.Second {
				backoff = 15 * time.Second
			}
		}
	}
}

func (p *Pool) connectAndMigrate(ctx context.Context) error {
	cfg, err := pgxpool.ParseConfig(p.url)
	if err != nil {
		return fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 8
	cfg.MinConns = 0
	cfg.MaxConnLifetime = time.Hour
	cfg.HealthCheckPeriod = 30 * time.Second
	if cfg.ConnConfig.ConnectTimeout == 0 {
		cfg.ConnConfig.ConnectTimeout = defaultConnectTimeout
	}

	connectCtx, cancelConnect := context.WithTimeout(ctx, defaultConnectTimeout)
	pool, err := pgxpool.NewWithConfig(connectCtx, cfg)
	if err != nil {
		cancelConnect()
		p.setErr(err)
		return err
	}
	if err := pool.Ping(connectCtx); err != nil {
		cancelConnect()
		pool.Close()
		p.setErr(err)
		return err
	}
	cancelConnect()

	migrateCtx, cancelMigrate := context.WithTimeout(ctx, p.migrateTimeout)
	defer cancelMigrate()
	if err := Migrate(migrateCtx, pool); err != nil {
		pool.Close()
		p.setErr(err)
		return fmt.Errorf("migrate: %w", err)
	}

	p.mu.Lock()
	if p.pool != nil {
		p.pool.Close()
	}
	p.pool = pool
	p.last = nil
	p.mu.Unlock()

	p.log.Info("postgres ready",
		"host", cfg.ConnConfig.Host,
		"database", cfg.ConnConfig.Database,
	)
	return nil
}

func (p *Pool) setErr(err error) {
	p.mu.Lock()
	p.last = err
	p.mu.Unlock()
}

// Ping reports whether PostgreSQL accepts a connection.
func (p *Pool) Ping(ctx context.Context) error {
	p.mu.RLock()
	pool := p.pool
	last := p.last
	p.mu.RUnlock()

	if pool == nil {
		if last != nil {
			return fmt.Errorf("%w: %v", ErrUnavailable, last)
		}
		return ErrUnavailable
	}

	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

// Close releases the underlying pool.
func (p *Pool) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pool != nil {
		p.pool.Close()
		p.pool = nil
	}
}

// Open connects once, migrates, and returns a live pool. Used by cmd/migrate.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is not set")
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if cfg.ConnConfig.ConnectTimeout == 0 {
		cfg.ConnConfig.ConnectTimeout = 10 * time.Second
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	if err := Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}
