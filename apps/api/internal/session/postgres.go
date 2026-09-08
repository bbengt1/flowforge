package session

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
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Postgres persists hashed sessions and audit events.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

// Create issues a new session bound to userID.
func (p *Postgres) Create(ctx context.Context, userID string, now time.Time, idle, absolute time.Duration) (Issued, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return Issued{}, ErrInvalid
	}
	idle, absolute = normalizeTimeouts(idle, absolute)
	token, err := newToken()
	if err != nil {
		return Issued{}, err
	}
	csrf, err := newToken()
	if err != nil {
		return Issued{}, err
	}
	now = now.UTC()
	var rec Record
	var csrfHash []byte
	err = p.db.QueryRow(ctx, `
		INSERT INTO browser_sessions (
			user_id, token_hash, csrf_hash, created_at, last_seen_at,
			idle_expires_at, absolute_expires_at
		) VALUES ($1::uuid, $2, $3, $4, $4, $5, $6)
		RETURNING id::text, user_id::text, created_at, last_seen_at,
		          idle_expires_at, absolute_expires_at, csrf_hash
	`, userID, hashToken(token), hashToken(csrf), now, now.Add(idle), now.Add(absolute)).Scan(
		&rec.ID, &rec.UserID, &rec.CreatedAt, &rec.LastSeenAt,
		&rec.IdleExpiresAt, &rec.AbsoluteExpiresAt, &csrfHash,
	)
	if err != nil {
		return Issued{}, mapDBErr(err)
	}
	rec.setCSRFHash(csrfHash)
	return Issued{Record: rec, Token: token, CSRF: csrf}, nil
}

// Lookup returns a live session for token.
func (p *Postgres) Lookup(ctx context.Context, token string, now time.Time) (Record, error) {
	rec, err := p.load(ctx, token)
	if err != nil {
		return Record{}, err
	}
	if err := Valid(rec, now.UTC()); err != nil {
		return rec, err
	}
	return rec, nil
}

// Refresh extends idle expiry and rotates CSRF. Absolute expiry is a hard cap.
func (p *Postgres) Refresh(ctx context.Context, token string, now time.Time, idle time.Duration) (Issued, error) {
	if idle <= 0 {
		idle = DefaultIdleTimeout
	}
	now = now.UTC()
	rec, err := p.load(ctx, token)
	if err != nil {
		return Issued{}, err
	}
	if err := Valid(rec, now); err != nil {
		return Issued{Record: rec}, err
	}
	csrf, err := newToken()
	if err != nil {
		return Issued{}, err
	}
	nextIdle := now.Add(idle)
	if nextIdle.After(rec.AbsoluteExpiresAt) {
		nextIdle = rec.AbsoluteExpiresAt
	}
	var csrfHash []byte
	err = p.db.QueryRow(ctx, `
		UPDATE browser_sessions
		   SET csrf_hash = $2,
		       last_seen_at = $3,
		       idle_expires_at = $4
		 WHERE token_hash = $1 AND revoked_at IS NULL
		 RETURNING id::text, user_id::text, created_at, last_seen_at,
		           idle_expires_at, absolute_expires_at, csrf_hash, revoked_at
	`, hashToken(token), hashToken(csrf), now, nextIdle).Scan(
		&rec.ID, &rec.UserID, &rec.CreatedAt, &rec.LastSeenAt,
		&rec.IdleExpiresAt, &rec.AbsoluteExpiresAt, &csrfHash, &rec.RevokedAt,
	)
	if err != nil {
		return Issued{}, mapDBErr(err)
	}
	rec.setCSRFHash(csrfHash)
	return Issued{Record: rec, Token: token, CSRF: csrf}, nil
}

// Revoke marks the session unusable.
func (p *Postgres) Revoke(ctx context.Context, token string, now time.Time) (Record, error) {
	rec, err := p.load(ctx, token)
	if err != nil {
		return Record{}, err
	}
	now = now.UTC()
	var csrfHash []byte
	err = p.db.QueryRow(ctx, `
		UPDATE browser_sessions
		   SET revoked_at = COALESCE(revoked_at, $2),
		       last_seen_at = $2
		 WHERE token_hash = $1
		 RETURNING id::text, user_id::text, created_at, last_seen_at,
		           idle_expires_at, absolute_expires_at, csrf_hash, revoked_at
	`, hashToken(token), now).Scan(
		&rec.ID, &rec.UserID, &rec.CreatedAt, &rec.LastSeenAt,
		&rec.IdleExpiresAt, &rec.AbsoluteExpiresAt, &csrfHash, &rec.RevokedAt,
	)
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	return rec, nil
}

// Touch updates last_seen without rotating CSRF.
func (p *Postgres) Touch(ctx context.Context, token string, now time.Time) error {
	rec, err := p.load(ctx, token)
	if err != nil {
		return err
	}
	if err := Valid(rec, now.UTC()); err != nil {
		return err
	}
	_, err = p.db.Exec(ctx, `
		UPDATE browser_sessions SET last_seen_at = $2
		 WHERE token_hash = $1 AND revoked_at IS NULL
	`, hashToken(token), now.UTC())
	return mapDBErr(err)
}

// Audit appends a secret-free event.
func (p *Postgres) Audit(ctx context.Context, event AuditEvent) error {
	event.EventType = strings.TrimSpace(event.EventType)
	event.Outcome = strings.TrimSpace(event.Outcome)
	event.Reason = strings.TrimSpace(event.Reason)
	if event.EventType == "" || event.Outcome == "" || event.Reason == "" {
		return ErrInvalid
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	var userID any
	if strings.TrimSpace(event.UserID) != "" {
		userID = event.UserID
	}
	var sessionID any
	if strings.TrimSpace(event.SessionID) != "" {
		sessionID = event.SessionID
	}
	_, err := p.db.Exec(ctx, `
		INSERT INTO session_audit_events (user_id, session_id, event_type, outcome, reason, request_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, userID, sessionID, event.EventType, event.Outcome, event.Reason, event.RequestID, event.CreatedAt.UTC())
	return mapDBErr(err)
}

// ListAudit returns the caller's events, newest first.
func (p *Postgres) ListAudit(ctx context.Context, userID string, limit int) ([]AuditEvent, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, ErrInvalid
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	rows, err := p.db.Query(ctx, `
		SELECT id::text, COALESCE(user_id::text, ''), COALESCE(session_id::text, ''),
		       event_type, outcome, reason, request_id, created_at
		  FROM session_audit_events
		 WHERE user_id = $1::uuid
		 ORDER BY created_at DESC
		 LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []AuditEvent{}
	for rows.Next() {
		var e AuditEvent
		if err := rows.Scan(&e.ID, &e.UserID, &e.SessionID, &e.EventType, &e.Outcome, &e.Reason, &e.RequestID, &e.CreatedAt); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, e)
	}
	return out, mapDBErr(rows.Err())
}

func (p *Postgres) load(ctx context.Context, token string) (Record, error) {
	if strings.TrimSpace(token) == "" {
		return Record{}, ErrNotFound
	}
	var rec Record
	var csrfHash []byte
	err := p.db.QueryRow(ctx, `
		SELECT id::text, user_id::text, created_at, last_seen_at,
		       idle_expires_at, absolute_expires_at, csrf_hash, revoked_at
		  FROM browser_sessions
		 WHERE token_hash = $1
	`, hashToken(token)).Scan(
		&rec.ID, &rec.UserID, &rec.CreatedAt, &rec.LastSeenAt,
		&rec.IdleExpiresAt, &rec.AbsoluteExpiresAt, &csrfHash, &rec.RevokedAt,
	)
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	rec.setCSRFHash(csrfHash)
	return rec, nil
}

func mapDBErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrInvalid
		case "23503":
			return ErrNotFound
		case "22P02":
			return ErrInvalid
		}
	}
	return err
}
