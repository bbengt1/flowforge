package identity

import (
	"context"
	"crypto/rand"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu         sync.Mutex
	tenants    map[string]Tenant
	workspaces map[string]Workspace
	users      map[string]User
	bindings   map[string][]string // workspaceID + "\x00" + userID -> role keys
}

// NewMemory returns a store seeded with the in-process permission catalog.
func NewMemory() *Memory {
	return &Memory{
		tenants:    map[string]Tenant{},
		workspaces: map[string]Workspace{},
		users:      map[string]User{},
		bindings:   map[string][]string{},
	}
}

func (m *Memory) UpsertUser(_ context.Context, issuer, subject, displayName string) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	displayName = strings.TrimSpace(displayName)
	if !authz.ValidIssuer(issuer) || !authz.ValidSubject(subject) {
		return User{}, ErrInvalid
	}
	if len(displayName) > 200 {
		return User{}, ErrInvalid
	}
	for _, u := range m.users {
		if u.Issuer == issuer && u.ExternalSubject == subject {
			if displayName != "" && u.DisplayName != displayName {
				u.DisplayName = displayName
				u.UpdatedAt = time.Now().UTC()
				m.users[u.ID] = u
			}
			return u, nil
		}
	}
	now := time.Now().UTC()
	u := User{
		ID:              newID(),
		Issuer:          issuer,
		ExternalSubject: subject,
		DisplayName:     displayName,
		Status:          "active",
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	m.users[u.ID] = u
	return u, nil
}

func (m *Memory) GetUser(_ context.Context, id string) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[id]
	if !ok {
		return User{}, ErrNotFound
	}
	return u, nil
}

func (m *Memory) CreateTenant(_ context.Context, slug, name string) (Tenant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	slug = strings.TrimSpace(slug)
	name = strings.TrimSpace(name)
	if !authz.ValidTenantSlug(slug) || name == "" || len(name) > 200 {
		return Tenant{}, ErrInvalid
	}
	for _, t := range m.tenants {
		if t.Slug == slug {
			return Tenant{}, ErrConflict
		}
	}
	now := time.Now().UTC()
	t := Tenant{ID: newID(), Slug: slug, Name: name, Status: "active", CreatedAt: now, UpdatedAt: now}
	m.tenants[t.ID] = t
	return t, nil
}

func (m *Memory) GetTenant(_ context.Context, id string) (Tenant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tenants[id]
	if !ok {
		return Tenant{}, ErrNotFound
	}
	return t, nil
}

func (m *Memory) GetTenantBySlug(_ context.Context, slug string) (Tenant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tenants {
		if t.Slug == slug {
			return t, nil
		}
	}
	return Tenant{}, ErrNotFound
}

func (m *Memory) CreateWorkspace(_ context.Context, tenantID, workbenchKey, name, creatorUserID string) (Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	workbenchKey = strings.TrimSpace(workbenchKey)
	name = strings.TrimSpace(name)
	if !authz.ValidWorkbenchKey(workbenchKey) || name == "" || len(name) > 200 {
		return Workspace{}, ErrInvalid
	}
	tenant, ok := m.tenants[tenantID]
	if !ok {
		return Workspace{}, ErrNotFound
	}
	if tenant.Status != "active" {
		return Workspace{}, ErrDisabled
	}
	if _, ok := m.users[creatorUserID]; !ok {
		return Workspace{}, ErrNotFound
	}
	for _, ws := range m.workspaces {
		if ws.TenantID == tenantID && ws.WorkbenchKey == workbenchKey {
			return Workspace{}, ErrConflict
		}
	}
	now := time.Now().UTC()
	ws := Workspace{
		ID: newID(), TenantID: tenantID, WorkbenchKey: workbenchKey,
		Name: name, Status: "active", CreatedAt: now, UpdatedAt: now,
	}
	m.workspaces[ws.ID] = ws
	m.bindings[bindKey(ws.ID, creatorUserID)] = []string{authz.RoleAdmin}
	return ws, nil
}

func (m *Memory) ResolveWorkspace(_ context.Context, tenantID, tenantSlug, workbenchKey string) (Workspace, Tenant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var tenant Tenant
	var found bool
	if tenantID != "" {
		tenant, found = m.tenants[tenantID]
		if !found {
			return Workspace{}, Tenant{}, ErrNotFound
		}
		if tenantSlug != "" && tenant.Slug != tenantSlug {
			return Workspace{}, Tenant{}, ErrNotFound
		}
	} else {
		for _, t := range m.tenants {
			if t.Slug == tenantSlug {
				tenant = t
				found = true
				break
			}
		}
		if !found {
			return Workspace{}, Tenant{}, ErrNotFound
		}
	}
	for _, ws := range m.workspaces {
		if ws.TenantID == tenant.ID && ws.WorkbenchKey == workbenchKey {
			return ws, tenant, nil
		}
	}
	return Workspace{}, Tenant{}, ErrNotFound
}

func (m *Memory) GetWorkspace(_ context.Context, id string) (Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ws, ok := m.workspaces[id]
	if !ok {
		return Workspace{}, ErrNotFound
	}
	return ws, nil
}

func (m *Memory) ListWorkspacesForUser(_ context.Context, userID string) ([]Membership, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Membership
	for key, roles := range m.bindings {
		wsID, uid := splitBindKey(key)
		if uid != userID {
			continue
		}
		ws, ok := m.workspaces[wsID]
		if !ok {
			continue
		}
		tenant := m.tenants[ws.TenantID]
		out = append(out, Membership{
			Workspace:   ws,
			Tenant:      tenant,
			Roles:       append([]string(nil), roles...),
			Permissions: authz.ExpandRoles(roles),
		})
	}
	return out, nil
}

func (m *Memory) ListRoles(_ context.Context) ([]Role, error) {
	return CatalogRoles(), nil
}

func (m *Memory) ListPermissions(_ context.Context) ([]Permission, error) {
	return CatalogPermissions(), nil
}

func (m *Memory) EffectiveAccess(_ context.Context, workspaceID, userID string) (roles, perms []string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ws, ok := m.workspaces[workspaceID]
	if !ok {
		return nil, nil, ErrNotFound
	}
	if ws.Status != "active" {
		return nil, nil, ErrDisabled
	}
	u, ok := m.users[userID]
	if !ok {
		return nil, nil, ErrNotFound
	}
	if u.Status != "active" {
		return nil, nil, ErrDisabled
	}
	roles = append([]string(nil), m.bindings[bindKey(workspaceID, userID)]...)
	return roles, authz.ExpandRoles(roles), nil
}

func (m *Memory) ListMembers(_ context.Context, workspaceID string) ([]Member, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.workspaces[workspaceID]; !ok {
		return nil, ErrNotFound
	}
	var out []Member
	for key, roles := range m.bindings {
		wsID, uid := splitBindKey(key)
		if wsID != workspaceID {
			continue
		}
		out = append(out, Member{
			User:        m.users[uid],
			Roles:       append([]string(nil), roles...),
			Permissions: authz.ExpandRoles(roles),
		})
	}
	return out, nil
}

func (m *Memory) SetMemberRoles(_ context.Context, workspaceID, userID string, roleKeys []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.workspaces[workspaceID]; !ok {
		return ErrNotFound
	}
	if _, ok := m.users[userID]; !ok {
		return ErrNotFound
	}
	if err := validateRoleKeys(roleKeys); err != nil {
		return err
	}
	next := uniqueSorted(roleKeys)
	prev := m.bindings[bindKey(workspaceID, userID)]
	m.bindings[bindKey(workspaceID, userID)] = next
	if err := m.ensureAdminLocked(workspaceID); err != nil {
		m.bindings[bindKey(workspaceID, userID)] = prev
		return err
	}
	return nil
}

func (m *Memory) RemoveMember(_ context.Context, workspaceID, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.workspaces[workspaceID]; !ok {
		return ErrNotFound
	}
	key := bindKey(workspaceID, userID)
	if _, ok := m.bindings[key]; !ok {
		return ErrNotFound
	}
	prev := m.bindings[key]
	delete(m.bindings, key)
	if err := m.ensureAdminLocked(workspaceID); err != nil {
		m.bindings[key] = prev
		return err
	}
	return nil
}

func (m *Memory) ResolveUserRef(ctx context.Context, userID, issuer, subject, displayName string) (User, error) {
	if strings.TrimSpace(userID) != "" {
		return m.GetUser(ctx, strings.TrimSpace(userID))
	}
	return m.UpsertUser(ctx, issuer, subject, displayName)
}

func (m *Memory) ensureAdminLocked(workspaceID string) error {
	for key, roles := range m.bindings {
		wsID, _ := splitBindKey(key)
		if wsID != workspaceID {
			continue
		}
		if slices.Contains(authz.ExpandRoles(roles), authz.PermWorkspaceAdminister) {
			return nil
		}
	}
	return ErrLastAdmin
}

func bindKey(workspaceID, userID string) string {
	return workspaceID + "\x00" + userID
}

func splitBindKey(key string) (workspaceID, userID string) {
	parts := strings.SplitN(key, "\x00", 2)
	if len(parts) != 2 {
		return "", ""
	}
	return parts[0], parts[1]
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func validateRoleKeys(roleKeys []string) error {
	if len(roleKeys) == 0 {
		return ErrInvalid
	}
	for _, k := range roleKeys {
		if !authz.KnownRole(k) {
			return ErrInvalid
		}
	}
	return nil
}

func uniqueSorted(in []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, v := range in {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	slices.Sort(out)
	return out
}
