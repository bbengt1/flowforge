package lockout

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

// Postgres persists lock state in auth_lockouts. A new process reading
// the same table still sees the lock.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) NoteFailure(ctx context.Context, userID string, max int, now time.Time) (State, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" || max < MinMaxFailures {
		return State{}, ErrInvalid
	}
	now = now.UTC()
	var st State
	var locked *time.Time
	err := p.db.QueryRow(ctx, `
		INSERT INTO auth_lockouts (user_id, failed_count, locked_at, updated_at)
		VALUES (
		    $1::uuid,
		    1,
		    CASE WHEN 1 >= $2::int THEN $3 ELSE NULL::timestamptz END,
		    $3
		)
		ON CONFLICT (user_id) DO UPDATE
		    SET failed_count = LEAST(auth_lockouts.failed_count + 1, $2::int),
		        locked_at = COALESCE(
		            auth_lockouts.locked_at,
		            CASE WHEN auth_lockouts.failed_count + 1 >= $2::int THEN $3 ELSE NULL::timestamptz END
		        ),
		        updated_at = $3
		RETURNING user_id::text, failed_count, locked_at, updated_at
	`, userID, max, now).Scan(&st.UserID, &st.Failed, &locked, &st.UpdatedAt)
	if err != nil {
		return State{}, mapErr(err)
	}
	st.LockedAt = locked
	return st, nil
}

func (p *Postgres) Get(ctx context.Context, userID string) (State, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return State{}, ErrInvalid
	}
	var st State
	var locked *time.Time
	err := p.db.QueryRow(ctx, `
		SELECT user_id::text, failed_count, locked_at, updated_at
		  FROM auth_lockouts
		 WHERE user_id = $1::uuid
	`, userID).Scan(&st.UserID, &st.Failed, &locked, &st.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return State{UserID: userID}, nil
		}
		return State{}, mapErr(err)
	}
	st.LockedAt = locked
	return st, nil
}

func (p *Postgres) Clear(ctx context.Context, userID string) error {
	return p.Unlock(ctx, userID)
}

func (p *Postgres) Unlock(ctx context.Context, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ErrInvalid
	}
	_, err := p.db.Exec(ctx, `DELETE FROM auth_lockouts WHERE user_id = $1::uuid`, userID)
	if err != nil {
		return mapErr(err)
	}
	return nil
}

func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503", "22P02":
			return ErrInvalid
		}
	}
	if errors.Is(err, ErrInvalid) {
		return err
	}
	return ErrUnavailable
}
