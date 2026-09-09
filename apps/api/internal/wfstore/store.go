// Package wfstore persists workspace-scoped workflow drafts, immutable
// published versions, and version-pinned execution stubs.
package wfstore

import (
	"context"
	"errors"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Persistence errors.
var (
	ErrNotFound         = errors.New("not found")
	ErrConflict         = errors.New("conflict")
	ErrRevisionConflict = errors.New("draft revision conflict")
	ErrInvalid          = errors.New("invalid")
	ErrNoScope          = errors.New("workspace scope is not set")
	ErrImmutable        = errors.New("published versions are immutable")
	ErrDraftNotRunnable = errors.New("drafts cannot be executed")
	ErrDuplicateVersion = errors.New("definition already published")
	ErrStoreUnavailable = errors.New("workflow store is unavailable")
)

// Validation states persisted with a draft.
const (
	ValidationValid   = "valid"
	ValidationInvalid = "invalid"
)

// Workflow statuses.
const (
	StatusDraft     = "draft"
	StatusPublished = "published"
	StatusArchived  = "archived"
)

// Execution statuses for the E3.2 pin stub (not the E5 engine).
const (
	ExecutionQueued = "queued"
	ExecutionPinned = "pinned"
)

// Workflow is the workspace-owned authoring record.
type Workflow struct {
	ID                  string    `json:"id"`
	Slug                string    `json:"slug"`
	Name                string    `json:"name"`
	Status              string    `json:"status"`
	DraftRevision       int64     `json:"draftRevision"`
	DraftDigest         string    `json:"draftDigest"`
	LatestVersionNumber int       `json:"latestVersionNumber"`
	LatestVersionID     string    `json:"latestVersionId,omitempty"`
	LatestVersionDigest string    `json:"latestVersionDigest,omitempty"`
	CreatedBy           string    `json:"createdBy,omitempty"`
	UpdatedBy           string    `json:"updatedBy,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

// Draft is the single mutable normalized document for a workflow.
type Draft struct {
	WorkflowID      string                `json:"workflowId"`
	Revision        int64                 `json:"revision"`
	DefinitionYAML  string                `json:"definitionYaml"`
	Digest          string                `json:"digest"`
	Summary         workflow.Summary      `json:"summary"`
	Warnings        []workflow.FieldError `json:"warnings"`
	ValidationState string                `json:"validationState"`
	UpdatedBy       string                `json:"updatedBy,omitempty"`
	UpdatedAt       time.Time             `json:"updatedAt"`
}

// Version is an immutable published snapshot.
type Version struct {
	ID             string           `json:"id"`
	WorkflowID     string           `json:"workflowId"`
	VersionNumber  int              `json:"versionNumber"`
	DefinitionYAML string           `json:"definitionYaml"`
	Digest         string           `json:"digest"`
	Summary        workflow.Summary `json:"summary"`
	PublishNote    string           `json:"publishNote"`
	PublishedBy    string           `json:"publishedBy,omitempty"`
	PublishedAt    time.Time        `json:"publishedAt"`
}

// Execution is a stub run pinned to a published version and digest.
type Execution struct {
	ID                string    `json:"id"`
	WorkflowID        string    `json:"workflowId"`
	WorkflowVersionID string    `json:"workflowVersionId"`
	WorkflowDigest    string    `json:"workflowDigest"`
	Status            string    `json:"status"`
	RequestedBy       string    `json:"requestedBy,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
}

// CompareRef selects a draft or published version for comparison.
type CompareRef struct {
	Kind          string `json:"kind"`
	VersionID     string `json:"versionId,omitempty"`
	VersionNumber int    `json:"versionNumber,omitempty"`
}

// Change is one structured difference between two definitions.
type Change struct {
	Path  string `json:"path"`
	Op    string `json:"op"`
	Left  any    `json:"left,omitempty"`
	Right any    `json:"right,omitempty"`
}

// CompareResult is the draft/version diff returned to the UI.
type CompareResult struct {
	Equal       bool       `json:"equal"`
	DigestMatch bool       `json:"digestMatch"`
	Left        CompareRef `json:"left"`
	Right       CompareRef `json:"right"`
	LeftDigest  string     `json:"leftDigest"`
	RightDigest string     `json:"rightDigest"`
	Changes     []Change   `json:"changes"`
}

// CreateInput creates a workflow and its first draft from normalized YAML.
type CreateInput struct {
	Slug           string
	Name           string
	NormalizedYAML string
	Digest         string
	Summary        workflow.Summary
}

// SaveInput is an optimistic draft update.
type SaveInput struct {
	ExpectedRevision int64
	NormalizedYAML   string
	Digest           string
	Summary          workflow.Summary
}

// PublishInput copies the current draft into an immutable version.
type PublishInput struct {
	ExpectedRevision int64
	Note             string
}

// RestoreInput copies a published version into the mutable draft.
type RestoreInput struct {
	VersionID        string
	ExpectedRevision int64
}

// StartInput starts a stub execution against a published version.
type StartInput struct {
	VersionID string
}

// Store persists drafts, versions, and pinned executions under a server scope.
type Store interface {
	Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Workflow, Draft, error)
	List(ctx context.Context, scope isolation.Scope) ([]Workflow, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Workflow, error)
	GetDraft(ctx context.Context, scope isolation.Scope, workflowID string) (Draft, error)
	SaveDraft(ctx context.Context, scope isolation.Scope, workflowID string, in SaveInput) (Workflow, Draft, error)
	Publish(ctx context.Context, scope isolation.Scope, workflowID string, in PublishInput) (Workflow, Version, error)
	ListVersions(ctx context.Context, scope isolation.Scope, workflowID string) ([]Version, error)
	GetVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (Version, error)
	Compare(ctx context.Context, scope isolation.Scope, workflowID string, left, right CompareRef) (CompareResult, error)
	Restore(ctx context.Context, scope isolation.Scope, workflowID string, in RestoreInput) (Workflow, Draft, error)
	StartExecution(ctx context.Context, scope isolation.Scope, workflowID string, in StartInput) (Execution, error)
	GetExecution(ctx context.Context, scope isolation.Scope, workflowID, executionID string) (Execution, error)
	FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]CredentialRef, error)
}

// Credential reference kinds returned to the vault for usage/deletion impact.
const (
	CredentialRefDraft     = "draft"
	CredentialRefVersion   = "version"
	CredentialRefExecution = "execution"
)

// CredentialRef is a secret-free pointer from a workflow document or pin
// to a credential UUID found in normalized YAML.
type CredentialRef struct {
	Kind            string `json:"kind"`
	WorkflowID      string `json:"workflowId"`
	WorkflowSlug    string `json:"workflowSlug"`
	WorkflowName    string `json:"workflowName"`
	VersionID       string `json:"versionId,omitempty"`
	VersionNumber   int    `json:"versionNumber,omitempty"`
	ExecutionID     string `json:"executionId,omitempty"`
	ExecutionStatus string `json:"executionStatus,omitempty"`
}
