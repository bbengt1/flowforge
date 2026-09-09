package scripts

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// Store persists immutable script artifacts and workflow-version pins.
type Store interface {
	Put(ctx context.Context, scope isolation.Scope, art Artifact) (Artifact, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Artifact, error)
	GetByDigest(ctx context.Context, scope isolation.Scope, digest string) (Artifact, error)
	BindVersion(ctx context.Context, scope isolation.Scope, workflowVersionID string, pins []VersionPin) ([]VersionPin, error)
	ListVersionPins(ctx context.Context, scope isolation.Scope, workflowVersionID string) ([]VersionPin, error)
	Revoke(ctx context.Context, scope isolation.Scope, id string, now time.Time, actorID, reason string) (Artifact, error)
}

// PutDraft is a test-only helper some stores expose to construct a mutable row.
type DraftPutter interface {
	PutDraft(ctx context.Context, scope isolation.Scope, art Artifact) (Artifact, error)
}
