package httpapi

import (
	"errors"
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/ha"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/lockout"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/mfa"
	"github.com/bbengt1/flowforge/apps/api/internal/oidc"
	"github.com/bbengt1/flowforge/apps/api/internal/opsalert"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/schedule"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// ReplicaBootError is set when Deps.Replicas is above one and a session
// or store is process-local. cmd/api exits before listen. The error names
// backends only.
func ReplicaBootError(h http.Handler) error {
	api, ok := h.(*API)
	if !ok || api == nil {
		return errors.New("api handler is not configured")
	}
	return api.replicaErr
}

// ProductionStoreBootError fails closed when a production-locked process
// selected an in-memory store for a durable domain (workflows, vault,
// executions, sessions, and the other process-local backends). cmd/api
// exits before listen. Non-production composition may keep memory stores
// for tests and local/dev. The error names backends only. There is no
// production override.
func ProductionStoreBootError(h http.Handler, productionLocked bool) error {
	api, ok := h.(*API)
	if !ok || api == nil {
		return errors.New("api handler is not configured")
	}
	return ha.RefuseMemoryStores(productionLocked, api.unshared)
}

func unsharedBackends(parts []namedBackend, artifactKind string) []string {
	var names []string
	for _, part := range parts {
		if memoryBackend(part.v) {
			names = append(names, part.name)
		}
	}
	if !ha.ArtifactShared(artifactKind) {
		names = append(names, "artifact")
	}
	return names
}

type namedBackend struct {
	name string
	v    any
}

func memoryBackend(v any) bool {
	switch v.(type) {
	case *session.Memory, *wfstore.Memory, *embed.MemoryJTI, *embed.MemoryKeys,
		*lockout.Memory, *vault.Memory, *identity.Memory, *isolation.Memory,
		*machine.Memory, *scim.Memory, *mfa.Memory, *bootstrap.Memory,
		*webhook.Memory, *schedule.Memory, *opsconfig.Memory, *approval.Memory,
		*opsalert.Memory, *scripts.Memory, *oidc.Memory, nil:
		return true
	default:
		return false
	}
}

func oidcBackend(c *oidc.Client) any {
	if c == nil {
		return nil
	}
	store := c.TransactionStore()
	if store == nil {
		return nil
	}
	return store
}

func embedKeyBackend(r *embed.Ring) any {
	if r == nil {
		return nil
	}
	store := r.KeyBackend()
	if store == nil {
		return nil
	}
	return store
}
