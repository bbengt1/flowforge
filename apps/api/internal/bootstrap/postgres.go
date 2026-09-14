package bootstrap

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the subset of pgx used by Postgres.
type DB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Postgres persists the singleton in instance_bootstrap.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

const selectSQL = `
	SELECT complete, skipped, persistence_ready, first_admin_ready,
	       public_url_ready, tls_ready, public_base_url, tls_mode,
	       completed_at, updated_at
	FROM instance_bootstrap
	WHERE id = $1
`

// Get loads the singleton. Missing row is treated as incomplete (fail closed
// toward the wizard, not toward "already done").
func (p *Postgres) Get(ctx context.Context) (State, error) {
	var s State
	var completedAt *time.Time
	err := p.db.QueryRow(ctx, selectSQL, SingletonID).Scan(
		&s.Complete, &s.Skipped, &s.PersistenceReady, &s.FirstAdminReady,
		&s.PublicURLReady, &s.TLSReady, &s.PublicBaseURL, &s.TLSMode,
		&completedAt, &s.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return State{TLSMode: TLSModeNone, UpdatedAt: time.Now().UTC()}, nil
		}
		return State{}, ErrUnavailable
	}
	s.CompletedAt = completedAt
	if strings.TrimSpace(s.TLSMode) == "" {
		s.TLSMode = TLSModeNone
	}
	return s, nil
}

// SetStep updates one readiness flag. It does not mark complete.
func (p *Postgres) SetStep(ctx context.Context, step string, ready bool) error {
	if !validStep(step) {
		return ErrInvalid
	}
	col := stepColumn(step)
	_, err := p.db.Exec(ctx, `
		UPDATE instance_bootstrap
		SET `+col+` = $2, updated_at = now()
		WHERE id = $1
	`, SingletonID, ready)
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

// SetPublicURL stores the server-only URL and marks publicUrl ready.
func (p *Postgres) SetPublicURL(ctx context.Context, publicBaseURL string) error {
	normalized, err := NormalizePublicBaseURL(publicBaseURL)
	if err != nil {
		return err
	}
	if normalized == "" {
		return ErrInvalid
	}
	_, err = p.db.Exec(ctx, `
		UPDATE instance_bootstrap
		SET public_base_url = $2, public_url_ready = true, updated_at = now()
		WHERE id = $1
	`, SingletonID, normalized)
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

// SetTLS updates TLS readiness and status-only mode.
func (p *Postgres) SetTLS(ctx context.Context, ready bool, mode string) error {
	normalized, err := NormalizeTLSMode(mode)
	if err != nil {
		return err
	}
	_, err = p.db.Exec(ctx, `
		UPDATE instance_bootstrap
		SET tls_ready = $2, tls_mode = $3, updated_at = now()
		WHERE id = $1
	`, SingletonID, ready, normalized)
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

// MarkComplete sets the overall gate. Wizard must not reappear after this.
func (p *Postgres) MarkComplete(ctx context.Context) error {
	_, err := p.db.Exec(ctx, `
		UPDATE instance_bootstrap
		SET complete = true,
		    completed_at = COALESCE(completed_at, now()),
		    updated_at = now()
		WHERE id = $1
	`, SingletonID)
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

// MarkSeedSkip marks trusted-dev / compose localseed complete (admin + URL).
func (p *Postgres) MarkSeedSkip(ctx context.Context, skip SeedSkip) error {
	url, err := ResolveSeedPublicURL(skip.PublicBaseURL)
	if err != nil {
		return err
	}
	_, err = p.db.Exec(ctx, `
		UPDATE instance_bootstrap
		SET complete = true,
		    skipped = true,
		    persistence_ready = true,
		    first_admin_ready = true,
		    public_url_ready = true,
		    public_base_url = CASE
		        WHEN public_base_url = '' THEN $2
		        ELSE public_base_url
		    END,
		    completed_at = COALESCE(completed_at, now()),
		    updated_at = now()
		WHERE id = $1
	`, SingletonID, url)
	if err != nil {
		return ErrUnavailable
	}
	return nil
}

func stepColumn(step string) string {
	switch step {
	case StepPersistence:
		return "persistence_ready"
	case StepFirstAdmin:
		return "first_admin_ready"
	case StepPublicURL:
		return "public_url_ready"
	case StepTLS:
		return "tls_ready"
	default:
		return ""
	}
}
