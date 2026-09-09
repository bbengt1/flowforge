package vault

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Event types persisted in credential_events.details_redacted.
const (
	EventCreated         = "created"
	EventRotated         = "rotated"
	EventDisabled        = "disabled"
	EventEnabled         = "enabled"
	EventTested          = "tested"
	EventUsed            = "used"
	EventMetadataUpdated = "metadata_updated"
	EventDeleted         = "deleted"
)

// Metadata is the only credential representation returned on HTTP APIs.
// It never includes secret fields, ciphertext, or DEK material.
type Metadata struct {
	ID                string            `json:"id"`
	Type              string            `json:"type"`
	DisplayName       string            `json:"displayName"`
	Status            string            `json:"status"`
	Tags              []string          `json:"tags"`
	Metadata          map[string]string `json:"metadata"`
	Fingerprint       string            `json:"fingerprint"`
	EncryptionVersion int               `json:"encryptionVersion"`
	KeyReference      string            `json:"keyReference"`
	LastTestStatus    string            `json:"lastTestStatus"`
	LastTestedAt      *time.Time        `json:"lastTestedAt,omitempty"`
	LastTestReason    string            `json:"lastTestReason,omitempty"`
	LastUsedAt        *time.Time        `json:"lastUsedAt,omitempty"`
	LastUsedBy        string            `json:"lastUsedBy,omitempty"`
	UseCount          int64             `json:"useCount"`
	RotatedAt         *time.Time        `json:"rotatedAt,omitempty"`
	ExpiresAt         *time.Time        `json:"expiresAt,omitempty"`
	DisabledAt        *time.Time        `json:"disabledAt,omitempty"`
	CreatedBy         string            `json:"createdBy,omitempty"`
	UpdatedBy         string            `json:"updatedBy,omitempty"`
	CreatedAt         time.Time         `json:"createdAt"`
	UpdatedAt         time.Time         `json:"updatedAt"`
	PermittedActions  []string          `json:"permittedActions,omitempty"`
}

// Event is a secret-free vault audit row.
type Event struct {
	ID           string         `json:"id"`
	CredentialID string         `json:"credentialId"`
	EventType    string         `json:"eventType"`
	ActorID      string         `json:"actorId,omitempty"`
	Details      map[string]any `json:"details"`
	OccurredAt   time.Time      `json:"occurredAt"`
}

// Usage is operator-visible references and last-use metadata.
type Usage struct {
	CredentialID string                  `json:"credentialId"`
	LastUsedAt   *time.Time              `json:"lastUsedAt,omitempty"`
	LastUsedBy   string                  `json:"lastUsedBy,omitempty"`
	UseCount     int64                   `json:"useCount"`
	Drafts       []wfstore.CredentialRef `json:"drafts"`
	Versions     []wfstore.CredentialRef `json:"versions"`
	Executions   []wfstore.CredentialRef `json:"executions"`
}

// DeletionImpact reports what a delete would affect.
type DeletionImpact struct {
	CredentialID     string                  `json:"credentialId"`
	DisplayName      string                  `json:"displayName"`
	Status           string                  `json:"status"`
	CanDelete        bool                    `json:"canDelete"`
	BlockReason      string                  `json:"blockReason,omitempty"`
	Drafts           []wfstore.CredentialRef `json:"drafts"`
	Versions         []wfstore.CredentialRef `json:"versions"`
	ActiveExecutions []wfstore.CredentialRef `json:"activeExecutions"`
}

// CreateInput is accepted only at create time. Secret is encrypted before persist.
type CreateInput struct {
	Type        string
	DisplayName string
	Tags        []string
	Metadata    map[string]string
	ExpiresAt   string
	Secret      map[string]string
}

// UpdateInput changes safe metadata only.
type UpdateInput struct {
	DisplayName *string
	Tags        *[]string
	Metadata    *map[string]string
	ExpiresAt   *string
}

// RotateInput replaces the encrypted payload.
type RotateInput struct {
	Secret map[string]string
}

// DeleteInput requires an explicit confirm.
type DeleteInput struct {
	Confirm bool
}

// TestResult is a redacted connection/shape check.
type TestResult struct {
	Status    string    `json:"status"`
	Reason    string    `json:"reason"`
	CheckedAt time.Time `json:"checkedAt"`
}

// Store persists encrypted credentials under a server-derived workspace scope.
type Store interface {
	Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Metadata, error)
	List(ctx context.Context, scope isolation.Scope) ([]Metadata, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Metadata, error)
	Update(ctx context.Context, scope isolation.Scope, id string, in UpdateInput) (Metadata, error)
	Rotate(ctx context.Context, scope isolation.Scope, id string, in RotateInput) (Metadata, error)
	Disable(ctx context.Context, scope isolation.Scope, id string) (Metadata, error)
	Enable(ctx context.Context, scope isolation.Scope, id string) (Metadata, error)
	Test(ctx context.Context, scope isolation.Scope, id string) (TestResult, Metadata, error)
	Use(ctx context.Context, scope isolation.Scope, id string) error
	Usage(ctx context.Context, scope isolation.Scope, id string) (Usage, error)
	DeletionImpact(ctx context.Context, scope isolation.Scope, id string) (DeletionImpact, error)
	Delete(ctx context.Context, scope isolation.Scope, id string, in DeleteInput) error
	Events(ctx context.Context, scope isolation.Scope, id string) ([]Event, error)
	// Unlock is in-process only (future workers). HTTP handlers must not
	// serialize the returned plaintext.
	Unlock(ctx context.Context, scope isolation.Scope, id string) ([]byte, error)
}

// RefFinder locates workflow YAML/execution references to a credential UUID.
type RefFinder interface {
	FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]wfstore.CredentialRef, error)
}
