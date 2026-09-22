package machine

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresMachineNoSecretEcho(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, machineTestDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	users := identity.NewPostgres(pool)
	store := NewPostgres(pool)
	secret := "machine-secret-value-1"
	hash, err := HashSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	clientID, err := NewClientID()
	if err != nil {
		t.Fatal(err)
	}
	user, err := users.UpsertUser(ctx, Issuer, clientID, "Postgres scraper")
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(ctx, Input{
		UserID:      user.ID,
		ClientID:    clientID,
		DisplayName: "Postgres scraper",
		SecretHash:  hash,
		Grants:      []string{authz.PermOpsMetricsRead},
		Now:         time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := Authenticate(created, secret, "", time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(created.View())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), secret) || strings.Contains(string(body), hash) || strings.Contains(string(body), "$2") {
		t.Fatalf("postgres view leaked secret: %s", body)
	}
	loaded, err := store.GetByClientID(ctx, clientID)
	if err != nil || loaded.ID != created.ID || !authz.Allows(loaded.Grants, authz.PermOpsMetricsRead) {
		t.Fatalf("load %+v %v", loaded.View(), err)
	}
	next, err := HashSecret("machine-secret-value-2")
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := store.Rotate(ctx, created.ID, Rotation{SecretHash: next, Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if err := Authenticate(rotated, secret, "", time.Now(), nil); err == nil {
		t.Fatal("old secret still worked")
	}
	revoked, err := store.Revoke(ctx, created.ID, time.Now().UTC())
	if err != nil || revoked.Status != StatusRevoked {
		t.Fatalf("revoke %+v %v", revoked.View(), err)
	}
	if err := users.SetUserStatus(ctx, user.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	got, err := users.GetUser(ctx, user.ID)
	if err != nil || got.Status != "disabled" {
		t.Fatalf("user status %q %v", got.Status, err)
	}
}

func machineTestDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	return dsn
}
