package opsconfig

import (
	"context"
	"errors"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpnotify"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	ssheng "github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Persistence errors.
var (
	ErrNotFound         = errors.New("not found")
	ErrConflict         = errors.New("conflict")
	ErrRevisionConflict = errors.New("draft revision conflict")
	ErrInvalid          = errors.New("invalid")
	ErrNoScope          = errors.New("workspace scope is not set")
	ErrImmutable        = errors.New("published versions are immutable")
	ErrNotPublished     = errors.New("resource is not published")
	ErrDisabled         = errors.New("resource is disabled")
	ErrDraftNotUsable   = errors.New("drafts cannot be selected")
	ErrCrossWorkspace   = errors.New("cross-workspace resource is not usable")
	ErrStoreUnavailable = errors.New("ops config store is unavailable")
)

// Resource is the workspace-owned head record.
type Resource struct {
	ID                  string    `json:"id"`
	Kind                string    `json:"kind"`
	Slug                string    `json:"slug"`
	Name                string    `json:"name"`
	Status              string    `json:"status"`
	DraftRevision       int64     `json:"draftRevision"`
	DraftDigest         string    `json:"draftDigest,omitempty"`
	LatestVersionNumber int       `json:"latestVersionNumber"`
	LatestVersionID     string    `json:"latestVersionId,omitempty"`
	LatestVersionDigest string    `json:"latestVersionDigest,omitempty"`
	CredentialID        string    `json:"credentialId,omitempty"`
	PolicyID            string    `json:"policyId,omitempty"`
	CreatedBy           string    `json:"createdBy,omitempty"`
	UpdatedBy           string    `json:"updatedBy,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

// Draft is the single mutable spec for a resource.
type Draft struct {
	ResourceID string         `json:"resourceId"`
	Kind       string         `json:"kind"`
	Revision   int64          `json:"revision"`
	Spec       map[string]any `json:"spec"`
	Digest     string         `json:"digest"`
	UpdatedBy  string         `json:"updatedBy,omitempty"`
	UpdatedAt  time.Time      `json:"updatedAt"`
}

// Version is an immutable published snapshot.
type Version struct {
	ID            string         `json:"id"`
	ResourceID    string         `json:"resourceId"`
	Kind          string         `json:"kind"`
	VersionNumber int            `json:"versionNumber"`
	Spec          map[string]any `json:"spec"`
	Digest        string         `json:"digest"`
	PublishNote   string         `json:"publishNote"`
	PublishedBy   string         `json:"publishedBy,omitempty"`
	PublishedAt   time.Time      `json:"publishedAt"`
}

// Pin is a server-authorized, version-exact reference.
type Pin struct {
	Kind          string         `json:"kind"`
	ResourceID    string         `json:"resourceId"`
	VersionID     string         `json:"versionId"`
	VersionNumber int            `json:"versionNumber"`
	Digest        string         `json:"digest"`
	Name          string         `json:"name,omitempty"`
	Slug          string         `json:"slug,omitempty"`
	Spec          map[string]any `json:"spec,omitempty"`
}

// Ref is an unresolved resource pointer from YAML or a select request.
type Ref struct {
	Kind       string `json:"kind"`
	ResourceID string `json:"resourceId"`
	VersionID  string `json:"versionId,omitempty"`
}

// CreateInput creates a resource and its first draft.
type CreateInput struct {
	Kind string
	Slug string
	Name string
	Spec map[string]any
}

// SaveInput is an optimistic draft update.
type SaveInput struct {
	ExpectedRevision int64
	Name             string
	Spec             map[string]any
}

// PublishInput copies the current draft into an immutable version.
type PublishInput struct {
	ExpectedRevision int64
	Note             string
}

// SelectInput resolves a published version for server-authorized use.
type SelectInput struct {
	VersionID string
}

// BindInput persists pins for a workflow version or execution.
type BindInput struct {
	OwnerKind string
	OwnerID   string
	Pins      []Pin
}

// Store persists drafts, immutable versions, and pins under server scope.
type Store interface {
	Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Resource, Draft, error)
	List(ctx context.Context, scope isolation.Scope, kind string) ([]Resource, error)
	Get(ctx context.Context, scope isolation.Scope, kind, id string) (Resource, error)
	GetDraft(ctx context.Context, scope isolation.Scope, kind, id string) (Draft, error)
	SaveDraft(ctx context.Context, scope isolation.Scope, kind, id string, in SaveInput) (Resource, Draft, error)
	Publish(ctx context.Context, scope isolation.Scope, kind, id string, in PublishInput) (Resource, Version, error)
	ListVersions(ctx context.Context, scope isolation.Scope, kind, id string) ([]Version, error)
	GetVersion(ctx context.Context, scope isolation.Scope, kind, id, versionID string) (Version, error)
	Disable(ctx context.Context, scope isolation.Scope, kind, id string) (Resource, error)
	Enable(ctx context.Context, scope isolation.Scope, kind, id string) (Resource, error)
	Select(ctx context.Context, scope isolation.Scope, kind, id string, in SelectInput) (Pin, error)
	Resolve(ctx context.Context, scope isolation.Scope, refs []Ref) ([]Pin, error)
	BindPins(ctx context.Context, scope isolation.Scope, in BindInput) ([]Pin, error)
	ListPins(ctx context.Context, scope isolation.Scope, ownerKind, ownerID string) ([]Pin, error)
	CopyPins(ctx context.Context, scope isolation.Scope, fromKind, fromID, toKind, toID string) ([]Pin, error)
	FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]wfstore.CredentialRef, error)
}

// Catalog is the UI/operator vocabulary for ops-config resources.
type Catalog struct {
	Kinds            []KindInfo               `json:"kinds"`
	Kubernetes       kubernetes.EngineCatalog `json:"kubernetesEngine"`
	SSH              ssheng.EngineCatalog     `json:"sshEngine"`
	Script           scripts.EngineCatalog    `json:"scriptEngine"`
	HTTPNotification httpnotify.EngineCatalog `json:"httpNotificationEngine"`
}

// TypeCatalog returns kind/collection/YAML field shapes plus engine rules.
func TypeCatalog() Catalog {
	return TypeCatalogWithGate(true)
}

// TypeCatalogWithGate applies the integration kill switch to httpNotificationEngine.
func TypeCatalogWithGate(integrationEnabled bool) Catalog {
	return Catalog{
		Kinds:            KindInfos(),
		Kubernetes:       kubernetes.Catalog(),
		SSH:              ssheng.Catalog(),
		Script:           scripts.Catalog(),
		HTTPNotification: httpnotify.CatalogWithEnabled(integrationEnabled),
	}
}
