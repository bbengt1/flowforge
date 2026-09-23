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
