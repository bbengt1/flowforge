package bootstrap

import (
	"context"
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
)

type txBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// CommitAdminPassword locks the singleton, checks presentedHash, writes
// the bcrypt passwordHash for userID, clears the token digest, and
// inserts bootstrap.admin_password_set. The plaintext token and
// password never enter this method. A second caller blocked on the
// row lock observes the cleared digest and gets ErrSetupComplete.
func (p *Postgres) CommitAdminPassword(ctx context.Context, presentedHash, userID, passwordHash, requestID string) error {
	beginner, ok := p.db.(txBeginner)
	if !ok {
		return ErrUnavailable
	}
	userID = strings.TrimSpace(userID)
	passwordHash = strings.TrimSpace(passwordHash)
	requestID = strings.TrimSpace(requestID)
	if userID == "" || passwordHash == "" || !ValidSetupTokenHash(presentedHash) {
		return ErrInvalid
	}
	if len(requestID) > 128 {
		requestID = requestID[:128]
	}
	tx, err := beginner.Begin(ctx)
	if err != nil {
		return ErrUnavailable
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var stored *string
	var current *string
	err = tx.QueryRow(ctx, `
		SELECT b.setup_token_hash, l.password_hash
		FROM instance_bootstrap b
		LEFT JOIN local_logins l ON l.user_id = $2::uuid
		WHERE b.id = $1
		FOR UPDATE OF b
	`, SingletonID, userID).Scan(&stored, &current)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSetupComplete
		}
		return ErrUnavailable
	}
	currentHash := ""
	if current != nil {
		currentHash = *current
	}
	if localauth.PasswordHashUsable(currentHash) {
		if _, err := tx.Exec(ctx, `
			UPDATE instance_bootstrap
			SET setup_token_hash = NULL, updated_at = now()
			WHERE id = $1
		`, SingletonID); err != nil {
			return ErrUnavailable
		}
		if err := tx.Commit(ctx); err != nil {
			return ErrUnavailable
		}
		return ErrSetupComplete
	}
	got := ""
	if stored != nil {
		got = *stored
	}
	if got == "" {
		return ErrSetupComplete
	}
	if !setupHashEqual(got, presentedHash) {
		return ErrSetupToken
	}
	tag, err := tx.Exec(ctx, `
		UPDATE local_logins
		   SET password_hash = $2,
		       must_change_password = false,
		       updated_at = now()
		 WHERE user_id = $1::uuid
	`, userID, passwordHash)
	if err != nil {
		return ErrUnavailable
	}
	if tag.RowsAffected() == 0 {
		return ErrUnavailable
	}
	if _, err := tx.Exec(ctx, `
		UPDATE instance_bootstrap
		SET setup_token_hash = NULL, updated_at = now()
		WHERE id = $1
	`, SingletonID); err != nil {
		return ErrUnavailable
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO session_audit_events (user_id, session_id, event_type, outcome, reason, request_id)
		VALUES ($1::uuid, NULL, $2, $3, $4, $5)
	`, userID, session.EventBootstrapAdminPasswordSet, session.OutcomeAllowed, "admin-password-set", requestID); err != nil {
		return ErrUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrUnavailable
	}
	return nil
}
