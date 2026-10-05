package bootstrap

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresCommitAdminPasswordRace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	var userID string
	if err := app.QueryRow(ctx, `
		INSERT INTO users (issuer, external_subject, display_name, status)
		VALUES ('local', 'setup-race-admin', 'Setup Race', 'active')
		RETURNING id::text
	`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanCancel()
		_, _ = app.Exec(cleanCtx, `DELETE FROM session_audit_events WHERE user_id = $1::uuid`, userID)
		_, _ = app.Exec(cleanCtx, `DELETE FROM local_logins WHERE user_id = $1::uuid`, userID)
		_, _ = app.Exec(cleanCtx, `DELETE FROM users WHERE id = $1::uuid`, userID)
		_, _ = app.Exec(cleanCtx, `UPDATE instance_bootstrap SET setup_token_hash = NULL WHERE id = 'default'`)
	})
	if _, err := app.Exec(ctx, `
		INSERT INTO local_logins (user_id, identifier, password_hash, must_change_password)
		VALUES ($1::uuid, 'setup-race-admin', '!', false)
	`, userID); err != nil {
		t.Fatal(err)
	}
	store := NewPostgres(app)
	const token = "setup-token-value1"
	if err := store.SetSetupTokenHash(ctx, HashSetupToken(token)); err != nil {
		t.Fatal(err)
	}
	passwordHash, err := localauth.HashPassword("correct-horse")
	if err != nil {
		t.Fatal(err)
	}
	presented := HashSetupToken(token)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func(i int) {
			defer wg.Done()
			errs[i] = store.CommitAdminPassword(ctx, presented, userID, passwordHash, "race-request-16")
		}(i)
	}
	wg.Wait()
	wins, loses := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, ErrSetupComplete):
			loses++
		default:
			t.Fatalf("race errors: %v", errs)
		}
	}
	if wins != 1 || loses != 1 {
		t.Fatalf("race errors: %v", errs)
	}
}
