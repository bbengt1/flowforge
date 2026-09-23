package httpapi

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestReplicasRefuseMemorySession(t *testing.T) {
	h := NewWithDeps(Deps{
		Sessions:        session.NewMemory(),
		Replicas:        2,
		ArtifactBackend: "memory",
	})
	err := ReplicaBootError(h)
	if err == nil {
		t.Fatal("replicas>1 with a memory session must fail closed")
	}
	open := strings.Index(err.Error(), "(")
	close := strings.Index(err.Error(), ")")
	if open < 0 || close <= open {
		t.Fatalf("error = %v", err)
	}
	has := map[string]bool{}
	for _, name := range strings.Split(err.Error()[open+1:close], ", ") {
		has[name] = true
	}
	for _, want := range []string{"session", "rate", "login-rate", "embed-rate", "machine-rate"} {
		if !has[want] {
			t.Fatalf("missing %s in %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "JOB_BINDING_SECRET") || strings.Contains(err.Error(), "SCRIPT_SIGNING_KEY") {
		t.Fatalf("error must not name HMAC secrets: %v", err)
	}
}

func TestSingleReplicaAllowsMemorySession(t *testing.T) {
	h := NewWithDeps(Deps{Sessions: session.NewMemory()})
	if err := ReplicaBootError(h); err != nil {
		t.Fatal(err)
	}
}

func TestProductionRefusesMemoryStores(t *testing.T) {
	h := NewWithDeps(Deps{
		Sessions:        session.NewMemory(),
		ArtifactBackend: "memory",
	})
	err := ProductionStoreBootError(h, true)
	if err == nil {
		t.Fatal("production-locked memory stores must fail closed")
	}
	open := strings.Index(err.Error(), "(")
	close := strings.Index(err.Error(), ")")
	if open < 0 || close <= open {
		t.Fatalf("error = %v", err)
	}
	has := map[string]bool{}
	for _, name := range strings.Split(err.Error()[open+1:close], ", ") {
		has[name] = true
	}
	for _, want := range []string{"session", "workflow", "vault", "artifact", "oidc", "embed-keys"} {
		if !has[want] {
			t.Fatalf("missing %s in %v", want, err)
		}
	}
	if !strings.Contains(err.Error(), "no production override") {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), "JOB_BINDING_SECRET") || strings.Contains(err.Error(), "SCRIPT_SIGNING_KEY") {
		t.Fatalf("error must not name HMAC secrets: %v", err)
	}
	if err := ProductionStoreBootError(h, false); err != nil {
		t.Fatalf("non-production memory path must stay available: %v", err)
	}
}

func TestProductionRefusesExplicitMemorySessionOnPool(t *testing.T) {
	pool := postgres.NewPool("postgres://flowforge@127.0.0.1:1/flowforge?sslmode=disable", slog.New(slog.DiscardHandler), time.Second)
	h := NewWithDeps(Deps{
		DB:              pool,
		Sessions:        session.NewMemory(),
		ArtifactBackend: "s3",
	})
	err := ProductionStoreBootError(h, true)
	if err == nil || !strings.Contains(err.Error(), "session") {
		t.Fatalf("explicit memory session must fail closed: %v", err)
	}
	if strings.Contains(err.Error(), "127.0.0.1") || strings.Contains(err.Error(), "flowforge@") {
		t.Fatalf("error must not echo the DSN: %v", err)
	}
}

func TestProductionAllowsPostgresStores(t *testing.T) {
	pool := postgres.NewPool("postgres://flowforge@127.0.0.1:1/flowforge?sslmode=disable", slog.New(slog.DiscardHandler), time.Second)
	h := NewWithDeps(Deps{
		DB:              pool,
		ArtifactBackend: "s3",
	})
	if err := ProductionStoreBootError(h, true); err != nil {
		t.Fatal(err)
	}
	if err := ProductionStoreBootError(nil, true); err == nil {
		t.Fatal("unconfigured handler must fail closed")
	}
}
