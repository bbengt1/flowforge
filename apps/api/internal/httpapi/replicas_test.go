package httpapi

import (
	"strings"
	"testing"

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
	if !strings.Contains(err.Error(), "session") {
		t.Fatalf("error = %v", err)
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
