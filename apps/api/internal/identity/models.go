package identity

import (
	"errors"
	"time"
)

// Persistence errors.
var (
	ErrNotFound         = errors.New("not found")
	ErrConflict         = errors.New("conflict")
	ErrInvalid          = errors.New("invalid")
	ErrLastAdmin        = errors.New("cannot remove the last workspace administrator")
	ErrDisabled         = errors.New("disabled")
	ErrStoreUnavailable = errors.New("identity store is unavailable")
)

// Tenant is an organization/host isolation root.
type Tenant struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Workspace is the operational isolation boundary.
type Workspace struct {
	ID           string    `json:"id"`
	TenantID     string    `json:"tenant_id"`
	WorkbenchKey string    `json:"workbench_key"`
	Name         string    `json:"name"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// User is an OIDC/host identity reference. No provider token is stored.
type User struct {
	ID              string    `json:"id"`
	Issuer          string    `json:"issuer"`
	ExternalSubject string    `json:"external_subject"`
	DisplayName     string    `json:"display_name"`
	Status          string    `json:"status"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// Member is a workspace binding.
type Member struct {
	User        User     `json:"user"`
	Roles       []string `json:"roles"`
	Permissions []string `json:"permissions"`
}

// Membership is a workspace the user belongs to.
type Membership struct {
	Workspace   Workspace `json:"workspace"`
	Tenant      Tenant    `json:"tenant"`
	Roles       []string  `json:"roles"`
	Permissions []string  `json:"permissions"`
}

// Role is a persisted role key.
type Role struct {
	Key         string   `json:"key"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

// Permission is a persisted permission key.
type Permission struct {
	Key string `json:"key"`
}
