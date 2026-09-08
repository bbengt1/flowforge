package isolation

import (
	"context"
	"time"
)

// Record is a workspace-owned isolation hook row.
type Record struct {
	WorkspaceID string         `json:"workspace_id"`
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	Name        string         `json:"name"`
	Metadata    map[string]any `json:"metadata"`
	CreatedBy   string         `json:"created_by,omitempty"`
	CreatedAt   time.Time      `json:"created_at"`
}

// Link is a child row constrained by (workspace_id, parent_id).
type Link struct {
	WorkspaceID string    `json:"workspace_id"`
	ID          string    `json:"id"`
	ParentID    string    `json:"parent_id"`
	Kind        string    `json:"kind"`
	CreatedAt   time.Time `json:"created_at"`
}

// Store persists isolation records under a server-derived scope.
type Store interface {
	Create(ctx context.Context, scope Scope, rec Record) (Record, error)
	Get(ctx context.Context, scope Scope, id string) (Record, error)
	List(ctx context.Context, scope Scope, kind string) ([]Record, error)
	Link(ctx context.Context, scope Scope, parentID, kind string) (Link, error)
	UseCredential(ctx context.Context, scope Scope, id string) error
	Subscribe(ctx context.Context, scope Scope, channelID string) error
}
