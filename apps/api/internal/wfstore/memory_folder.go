package wfstore

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

type memFolder struct {
	workspaceID string
	record      Folder
}

func (m *Memory) CreateFolder(_ context.Context, scope isolation.Scope, in CreateFolderInput) (Folder, error) {
	if scope.Zero() {
		return Folder{}, ErrNoScope
	}
	name, err := NormalizeFolderName(in.Name)
	if err != nil {
		return Folder{}, err
	}
	parentID := strings.TrimSpace(in.ParentID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if parentID != "" {
		parent, ok := m.lookupFolderLocked(scope, parentID)
		if !ok {
			return Folder{}, ErrNotFound
		}
		if folderDepthLocked(m.folders, parent.record.ID) >= MaxFolderDepth {
			return Folder{}, ErrFolderDepth
		}
	}
	if m.siblingNameTakenLocked(scope.WorkspaceID(), optionalID(parentID), name, "") {
		return Folder{}, ErrConflict
	}
	now := time.Now().UTC()
	rec := Folder{
		ID:          newID(),
		WorkspaceID: scope.WorkspaceID(),
		ParentID:    optionalID(parentID),
		Name:        name,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if m.folders == nil {
		m.folders = map[string]memFolder{}
	}
	m.folders[rec.ID] = memFolder{workspaceID: scope.WorkspaceID(), record: rec}
	return cloneFolder(rec), nil
}

func (m *Memory) ListFolders(_ context.Context, scope isolation.Scope) ([]Folder, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Folder
	for _, row := range m.folders {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		out = append(out, cloneFolder(row.record))
	}
	sortFolders(out)
	if out == nil {
		out = []Folder{}
	}
	return out, nil
}

func (m *Memory) GetFolder(_ context.Context, scope isolation.Scope, folderID string) (Folder, error) {
	if scope.Zero() {
		return Folder{}, ErrNoScope
	}
	if !authz.ValidUUID(folderID) {
		return Folder{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.lookupFolderLocked(scope, folderID)
	if !ok {
		return Folder{}, ErrNotFound
	}
	return cloneFolder(row.record), nil
}

func (m *Memory) UpdateFolder(_ context.Context, scope isolation.Scope, folderID string, in UpdateFolderInput) (Folder, error) {
	if scope.Zero() {
		return Folder{}, ErrNoScope
	}
	if !authz.ValidUUID(folderID) {
		return Folder{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.lookupFolderLocked(scope, folderID)
	if !ok {
		return Folder{}, ErrNotFound
	}
	name := row.record.Name
	if in.Name != nil {
		normalized, err := NormalizeFolderName(*in.Name)
		if err != nil {
			return Folder{}, err
		}
		name = normalized
	}
	parentID := row.record.ParentID
	if in.ParentID != nil {
		next := strings.TrimSpace(*in.ParentID)
		if next == "" {
			parentID = nil
		} else {
			if !authz.ValidUUID(next) {
				return Folder{}, ErrNotFound
			}
			if next == folderID {
				return Folder{}, ErrFolderCycle
			}
			parent, ok := m.lookupFolderLocked(scope, next)
			if !ok {
				return Folder{}, ErrNotFound
			}
			if folderIsAncestorLocked(m.folders, next, folderID) {
				return Folder{}, ErrFolderCycle
			}
			newDepth := folderDepthLocked(m.folders, parent.record.ID) + 1
			if newDepth+folderSubtreeHeightLocked(m.folders, folderID)-1 > MaxFolderDepth {
				return Folder{}, ErrFolderDepth
			}
			parentID = optionalID(next)
		}
	}
	if m.siblingNameTakenLocked(scope.WorkspaceID(), parentID, name, folderID) {
		return Folder{}, ErrConflict
	}
	row.record.Name = name
	row.record.ParentID = parentID
	row.record.UpdatedAt = time.Now().UTC()
	m.folders[folderID] = row
	return cloneFolder(row.record), nil
}

func (m *Memory) DeleteFolder(_ context.Context, scope isolation.Scope, folderID string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if !authz.ValidUUID(folderID) {
		return ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.lookupFolderLocked(scope, folderID); !ok {
		return ErrNotFound
	}
	childFolders := 0
	for _, row := range m.folders {
		if row.workspaceID == scope.WorkspaceID() && row.record.ParentID != nil && *row.record.ParentID == folderID {
			childFolders++
		}
	}
	workflows := 0
	for _, row := range m.workflows {
		if row.workspaceID == scope.WorkspaceID() && row.record.FolderID != nil && *row.record.FolderID == folderID {
			workflows++
		}
	}
	if childFolders > 0 || workflows > 0 {
		return FolderNotEmptyError{WorkflowCount: workflows, ChildFolderCount: childFolders}
	}
	delete(m.folders, folderID)
	return nil
}

func (m *Memory) SetWorkflowFolder(_ context.Context, scope isolation.Scope, workflowID, folderID string) (Workflow, error) {
	if scope.Zero() {
		return Workflow{}, ErrNoScope
	}
	folderID = strings.TrimSpace(folderID)
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.workflows[workflowID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Workflow{}, ErrNotFound
	}
	if folderID != "" {
		if !authz.ValidUUID(folderID) {
			return Workflow{}, ErrNotFound
		}
		if _, found := m.lookupFolderLocked(scope, folderID); !found {
			return Workflow{}, ErrNotFound
		}
		row.record.FolderID = optionalID(folderID)
	} else {
		row.record.FolderID = nil
	}
	m.workflows[workflowID] = row
	return publicWorkflow(row), nil
}

func (m *Memory) lookupFolderLocked(scope isolation.Scope, folderID string) (memFolder, bool) {
	row, ok := m.folders[folderID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return memFolder{}, false
	}
	return row, true
}

func (m *Memory) siblingNameTakenLocked(workspaceID string, parentID *string, name, exceptID string) bool {
	for _, row := range m.folders {
		if row.workspaceID != workspaceID || row.record.ID == exceptID {
			continue
		}
		if sameFolderParent(row.record.ParentID, parentID) && strings.EqualFold(row.record.Name, name) {
			return true
		}
	}
	return false
}

func folderDepthLocked(folders map[string]memFolder, id string) int {
	depth := 0
	seen := map[string]bool{}
	current := strings.TrimSpace(id)
	for current != "" {
		if seen[current] {
			return depth
		}
		seen[current] = true
		row, ok := folders[current]
		if !ok {
			break
		}
		depth++
		if row.record.ParentID == nil {
			break
		}
		current = strings.TrimSpace(*row.record.ParentID)
	}
	return depth
}

func folderSubtreeHeightLocked(folders map[string]memFolder, id string) int {
	maxHeight := 1
	var walk func(string, int)
	walk = func(parent string, height int) {
		if height > maxHeight {
			maxHeight = height
		}
		for _, row := range folders {
			if row.record.ParentID != nil && *row.record.ParentID == parent {
				walk(row.record.ID, height+1)
			}
		}
	}
	walk(id, 1)
	return maxHeight
}

func folderIsAncestorLocked(folders map[string]memFolder, startID, ancestorID string) bool {
	seen := map[string]bool{}
	current := strings.TrimSpace(startID)
	for current != "" {
		if current == ancestorID {
			return true
		}
		if seen[current] {
			return true
		}
		seen[current] = true
		row, ok := folders[current]
		if !ok || row.record.ParentID == nil {
			return false
		}
		current = strings.TrimSpace(*row.record.ParentID)
	}
	return false
}

func sortFolders(items []Folder) {
	sort.Slice(items, func(i, j int) bool {
		left := strings.ToLower(items[i].Name)
		right := strings.ToLower(items[j].Name)
		if left == right {
			return items[i].ID < items[j].ID
		}
		return left < right
	})
}
