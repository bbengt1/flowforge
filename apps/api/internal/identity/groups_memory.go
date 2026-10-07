package identity

import (
	"context"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
)

var _ GroupStore = (*Memory)(nil)

type memGroup struct {
	workspaceID string
	group       Group
	members     map[string]time.Time // userID -> added_at
}

// GroupAuditRecord is the in-memory copy of a group audit row (tests).
type GroupAuditRecord struct {
	WorkspaceID string
	ActorID     string
	Action      string
	GroupID     string
	Outcome     string
	Details     map[string]string
}

// GroupAudit returns the recorded group audit rows (tests only).
func (m *Memory) GroupAudit() []GroupAuditRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]GroupAuditRecord(nil), m.groupAudit...)
}

func (m *Memory) auditGroupLocked(workspaceID string, actor GroupActor, action, groupID, outcome string, extra map[string]string) {
	details := map[string]string{"groupId": groupID}
	for k, v := range extra {
		details[k] = v
	}
	m.groupAudit = append(m.groupAudit, GroupAuditRecord{
		WorkspaceID: workspaceID, ActorID: actor.UserID, Action: action,
		GroupID: groupID, Outcome: outcome, Details: details,
	})
}

func (m *Memory) groupLocked(workspaceID, groupID string) (*memGroup, error) {
	g, ok := m.groups[strings.ToLower(strings.TrimSpace(groupID))]
	if !ok || g.workspaceID != workspaceID {
		return nil, ErrNotFound
	}
	return g, nil
}

func (m *Memory) nameTakenLocked(workspaceID, name, exceptID string) bool {
	for id, g := range m.groups {
		if g.workspaceID == workspaceID && id != exceptID && strings.EqualFold(g.group.DisplayName, name) {
			return true
		}
	}
	return false
}

// activeBoundLocked is the eligibility rule: active user with a live
// binding in the workspace.
func (m *Memory) activeBoundLocked(workspaceID, userID string) bool {
	u, ok := m.users[userID]
	if !ok || u.Status != "active" {
		return false
	}
	return len(m.bindings[bindKey(workspaceID, userID)]) > 0
}

func (m *Memory) dropGroupRowsLocked(workspaceID, userID string) {
	for _, g := range m.groups {
		if g.workspaceID == workspaceID {
			delete(g.members, userID)
		}
	}
}

func (m *Memory) ListGroupsPage(_ context.Context, workspaceID string, q page.Query) ([]Group, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := []Group{}
	for _, g := range m.groups {
		if g.workspaceID != workspaceID {
			continue
		}
		out := g.group
		out.MemberCount = len(g.members)
		rows = append(rows, out)
	}
	return page.Select(page.ColGroup, q, false, rows, func(g Group) page.Key {
		return page.Key{K: strings.ToLower(g.DisplayName), ID: g.ID}
	}, func(g Group) bool {
		return page.Hit(q.Q, g.DisplayName)
	})
}

func (m *Memory) CreateGroup(_ context.Context, workspaceID string, actor GroupActor, displayName string) (Group, error) {
	name, err := NormalizeGroupName(displayName)
	if err != nil {
		return Group{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.workspaces[workspaceID]; !ok {
		return Group{}, ErrNotFound
	}
	if m.nameTakenLocked(workspaceID, name, "") {
		return Group{}, ErrGroupNameTaken
	}
	now := time.Now().UTC()
	g := &memGroup{
		workspaceID: workspaceID,
		group:       Group{ID: newID(), DisplayName: name, CreatedAt: now, UpdatedAt: now},
		members:     map[string]time.Time{},
	}
	m.groups[g.group.ID] = g
	m.auditGroupLocked(workspaceID, actor, AuditGroupCreate, g.group.ID, "created", nil)
	return g.group, nil
}

func (m *Memory) GetGroup(_ context.Context, workspaceID, groupID string) (GroupDetail, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, err := m.groupLocked(workspaceID, groupID)
	if err != nil {
		return GroupDetail{}, err
	}
	d := GroupDetail{Group: g.group, Members: []GroupMember{}}
	for userID := range g.members {
		u := m.users[userID]
		d.Members = append(d.Members, GroupMember{
			UserID:      userID,
			DisplayName: u.DisplayName,
			CanApprove:  memberCanApprove(u.Status, m.bindings[bindKey(workspaceID, userID)]),
		})
	}
	sort.Slice(d.Members, func(i, j int) bool {
		a, b := strings.ToLower(d.Members[i].DisplayName), strings.ToLower(d.Members[j].DisplayName)
		if a != b {
			return a < b
		}
		return d.Members[i].UserID < d.Members[j].UserID
	})
	d.MemberCount = len(d.Members)
	return d, nil
}

func (m *Memory) RenameGroup(_ context.Context, workspaceID string, actor GroupActor, groupID, displayName string) (Group, error) {
	name, err := NormalizeGroupName(displayName)
	if err != nil {
		return Group{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	g, err := m.groupLocked(workspaceID, groupID)
	if err != nil {
		return Group{}, err
	}
	if g.group.DisplayName == name {
		// Nothing changed: no update and no audit row.
		out := g.group
		out.MemberCount = len(g.members)
		return out, nil
	}
	if m.nameTakenLocked(workspaceID, name, g.group.ID) {
		return Group{}, ErrGroupNameTaken
	}
	g.group.DisplayName = name
	g.group.UpdatedAt = time.Now().UTC()
	m.auditGroupLocked(workspaceID, actor, AuditGroupRename, g.group.ID, "updated", nil)
	out := g.group
	out.MemberCount = len(g.members)
	return out, nil
}

func (m *Memory) DeleteGroup(_ context.Context, workspaceID string, actor GroupActor, groupID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, err := m.groupLocked(workspaceID, groupID)
	if err != nil {
		return err
	}
	delete(m.groups, g.group.ID)
	m.auditGroupLocked(workspaceID, actor, AuditGroupDelete, g.group.ID, "deleted", nil)
	return nil
}

func (m *Memory) AddGroupMember(_ context.Context, workspaceID string, actor GroupActor, groupID, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, err := m.groupLocked(workspaceID, groupID)
	if err != nil {
		return err
	}
	userID = strings.ToLower(strings.TrimSpace(userID))
	if !authz.ValidUUID(userID) || !m.activeBoundLocked(workspaceID, userID) {
		return ErrGroupMemberNotInWorkspace
	}
	if _, ok := g.members[userID]; ok {
		return nil
	}
	g.members[userID] = time.Now().UTC()
	m.auditGroupLocked(workspaceID, actor, AuditGroupMemberAdd, g.group.ID, "added", map[string]string{"userId": userID})
	return nil
}

func (m *Memory) RemoveGroupMember(_ context.Context, workspaceID string, actor GroupActor, groupID, userID string) error {
	// Same order as Postgres: a groupId that is not a UUID is not-found,
	// then a userId that is not a UUID is invalid.
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	userID = strings.ToLower(strings.TrimSpace(userID))
	if !authz.ValidUUID(userID) {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	g, err := m.groupLocked(workspaceID, groupID)
	if err != nil {
		return err
	}
	if _, ok := g.members[userID]; !ok {
		return nil
	}
	delete(g.members, userID)
	m.auditGroupLocked(workspaceID, actor, AuditGroupMemberRemove, g.group.ID, "removed", map[string]string{"userId": userID})
	return nil
}

// InTargetGroups is the in-memory twin of the package-level helper, for
// memory-backed approval tests. Same eligibility rule; no locking beyond
// the store mutex.
func (m *Memory) InTargetGroups(_ context.Context, workspaceID, userID string, groupIDs []string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	userID = strings.ToLower(strings.TrimSpace(userID))
	if !m.activeBoundLocked(workspaceID, userID) {
		return false, nil
	}
	for _, id := range validGroupIDs(groupIDs) {
		g, err := m.groupLocked(workspaceID, id)
		if err != nil {
			continue
		}
		if _, ok := g.members[userID]; ok {
			return true, nil
		}
	}
	return false, nil
}

// ResolveApprovalSnapshot is the in-memory twin of
// parkedapproval.ResolveSnapshot. It gathers the same candidates (named
// users plus members of named groups that exist in the workspace, with
// status and role keys) and applies the shared parkedapproval.BuildSnapshot
// rule, so park in memory fails no_eligible_decider exactly when Postgres
// would.
func (m *Memory) ResolveApprovalSnapshot(_ context.Context, workspaceID, requester, role string, users, groups []string) (parkedapproval.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	requester = strings.ToLower(strings.TrimSpace(requester))
	existing := []string{}
	named := map[string]bool{}
	order := []string{}
	add := func(id string, isNamed bool) {
		if _, seen := named[id]; !seen {
			order = append(order, id)
		}
		named[id] = named[id] || isNamed
	}
	for _, id := range validGroupIDs(users) {
		add(id, true)
	}
	for _, id := range validGroupIDs(groups) {
		g, err := m.groupLocked(workspaceID, id)
		if err != nil {
			continue
		}
		existing = append(existing, id)
		for userID := range g.members {
			add(userID, false)
		}
	}
	sort.Strings(existing)
	sort.Strings(order)
	cands := make([]parkedapproval.Candidate, 0, len(order))
	for _, id := range order {
		u, ok := m.users[id]
		if !ok {
			continue
		}
		cands = append(cands, parkedapproval.Candidate{ID: id, Named: named[id], Status: u.Status, Roles: append([]string(nil), m.bindings[bindKey(workspaceID, id)]...)})
	}
	return parkedapproval.BuildSnapshot(requester, role, existing, cands, func() (bool, error) {
		for key, roles := range m.bindings {
			ws, userID, ok := strings.Cut(key, "\x00")
			if !ok || ws != workspaceID || userID == requester || !slices.Contains(roles, "admin") {
				continue
			}
			if u, ok := m.users[userID]; ok && u.Status == "active" {
				return true, nil
			}
		}
		return false, nil
	})
}

// ResolveTargetUsers is the in-memory twin of the package-level helper.
func (m *Memory) ResolveTargetUsers(_ context.Context, workspaceID string, groupIDs, userIDs []string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	set := map[string]bool{}
	for _, id := range validGroupIDs(userIDs) {
		set[id] = true
	}
	for _, id := range validGroupIDs(groupIDs) {
		g, err := m.groupLocked(workspaceID, id)
		if err != nil {
			continue
		}
		for userID := range g.members {
			set[userID] = true
		}
	}
	out := []string{}
	for id := range set {
		if m.activeBoundLocked(workspaceID, id) {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out, nil
}
