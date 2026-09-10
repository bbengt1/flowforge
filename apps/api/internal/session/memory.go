package session

import (
	"context"
	"strings"
	"sync"
	"time"
)

type memoryRow struct {
	record    Record
	tokenHash string
}

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu     sync.Mutex
	byHash map[string]memoryRow
	audit  []AuditEvent
}

// NewMemory returns an empty session store.
func NewMemory() *Memory {
	return &Memory{byHash: map[string]memoryRow{}}
}

// Create issues a new session bound to userID.
func (m *Memory) Create(_ context.Context, userID string, now time.Time, idle, absolute time.Duration, opts ...CreateOpts) (Issued, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return Issued{}, ErrInvalid
	}
	idle, absolute = normalizeTimeouts(idle, absolute)
	token, err := newToken()
	if err != nil {
		return Issued{}, err
	}
	csrf, err := newToken()
	if err != nil {
		return Issued{}, err
	}
	now = now.UTC()
	rec := Record{
		ID:                newID(),
		UserID:            userID,
		CreatedAt:         now,
		LastSeenAt:        now,
		IdleExpiresAt:     now.Add(idle),
		AbsoluteExpiresAt: now.Add(absolute),
		Binding:           mergeCreateBinding(opts),
	}
	rec.setCSRFHash(hashToken(csrf))
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byHash[string(hashToken(token))] = memoryRow{record: rec, tokenHash: string(hashToken(token))}
	return Issued{Record: rec, Token: token, CSRF: csrf}, nil
}

// Lookup returns a live session for token.
func (m *Memory) Lookup(_ context.Context, token string, now time.Time) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.byHash[string(hashToken(token))]
	if !ok {
		return Record{}, ErrNotFound
	}
	if err := Valid(row.record, now.UTC()); err != nil {
		return row.record, err
	}
	return row.record, nil
}

// Refresh extends idle expiry and rotates the CSRF token. The session cookie
// is unchanged. Absolute expiry is a hard cap.
func (m *Memory) Refresh(_ context.Context, token, presentedCSRF string, now time.Time, idle time.Duration) (Issued, error) {
	if idle <= 0 {
		idle = DefaultIdleTimeout
	}
	now = now.UTC()
	csrf, err := newToken()
	if err != nil {
		return Issued{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(hashToken(token))
	row, ok := m.byHash[key]
	if !ok {
		return Issued{}, ErrNotFound
	}
	if err := Valid(row.record, now); err != nil {
		return Issued{Record: row.record}, err
	}
	if !csrfMatches(row.record, presentedCSRF) {
		return Issued{Record: row.record}, ErrConflict
	}
	nextIdle := now.Add(idle)
	if nextIdle.After(row.record.AbsoluteExpiresAt) {
		nextIdle = row.record.AbsoluteExpiresAt
	}
	row.record.LastSeenAt = now
	row.record.IdleExpiresAt = nextIdle
	row.record.setCSRFHash(hashToken(csrf))
	m.byHash[key] = row
	return Issued{Record: row.record, Token: token, CSRF: csrf}, nil
}

// Revoke marks the session unusable.
func (m *Memory) Revoke(_ context.Context, token string, now time.Time) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(hashToken(token))
	row, ok := m.byHash[key]
	if !ok {
		return Record{}, ErrNotFound
	}
	now = now.UTC()
	if row.record.RevokedAt == nil {
		t := now
		row.record.RevokedAt = &t
		row.record.LastSeenAt = now
		m.byHash[key] = row
	}
	return row.record, nil
}

// RevokeBoundToWorkspace marks embed sessions for the workspace unusable.
// Standalone (unbound) sessions are left intact.
func (m *Memory) RevokeBoundToWorkspace(_ context.Context, workspaceID, tenantID, workbenchKey string, now time.Time) ([]Record, error) {
	workspaceID, tenantID, workbenchKey, err := revokeWorkspaceArgs(workspaceID, tenantID, workbenchKey)
	if err != nil {
		return nil, err
	}
	now = now.UTC()
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Record{}
	for key, row := range m.byHash {
		if row.record.RevokedAt != nil {
			continue
		}
		if !BoundToWorkspace(row.record.Binding, workspaceID, tenantID, workbenchKey) {
			continue
		}
		t := now
		row.record.RevokedAt = &t
		row.record.LastSeenAt = now
		m.byHash[key] = row
		out = append(out, row.record)
	}
	return out, nil
}

// Touch updates last_seen without rotating CSRF.
func (m *Memory) Touch(_ context.Context, token string, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(hashToken(token))
	row, ok := m.byHash[key]
	if !ok {
		return ErrNotFound
	}
	if err := Valid(row.record, now.UTC()); err != nil {
		return err
	}
	row.record.LastSeenAt = now.UTC()
	m.byHash[key] = row
	return nil
}

// Audit appends a secret-free event.
func (m *Memory) Audit(_ context.Context, event AuditEvent) error {
	if strings.TrimSpace(event.EventType) == "" || strings.TrimSpace(event.Outcome) == "" || strings.TrimSpace(event.Reason) == "" {
		return ErrInvalid
	}
	if event.ID == "" {
		event.ID = newID()
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	} else {
		event.CreatedAt = event.CreatedAt.UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.audit = append(m.audit, event)
	return nil
}

// ListAudit returns the caller's events, newest first.
func (m *Memory) ListAudit(_ context.Context, userID string, limit int) ([]AuditEvent, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, ErrInvalid
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []AuditEvent
	for i := len(m.audit) - 1; i >= 0 && len(out) < limit; i-- {
		if m.audit[i].UserID == userID {
			out = append(out, m.audit[i])
		}
	}
	if out == nil {
		out = []AuditEvent{}
	}
	return out, nil
}
