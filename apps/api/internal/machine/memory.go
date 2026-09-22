package machine

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu       sync.Mutex
	byID     map[string]Principal
	byClient map[string]string
	byUser   map[string]string
	jti      map[string]time.Time
}

// NewMemory returns an empty store.
func NewMemory() *Memory {
	return &Memory{
		byID:     map[string]Principal{},
		byClient: map[string]string{},
		byUser:   map[string]string{},
		jti:      map[string]time.Time{},
	}
}

func (m *Memory) Create(_ context.Context, in Input) (Principal, error) {
	p, err := normalizeInput(in)
	if err != nil {
		return Principal{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.byClient[p.ClientID]; ok {
		return Principal{}, ErrConflict
	}
	if _, ok := m.byUser[p.UserID]; ok {
		return Principal{}, ErrConflict
	}
	m.byID[p.ID] = p
	m.byClient[p.ClientID] = p.ID
	m.byUser[p.UserID] = p.ID
	return p.clone(), nil
}

func (m *Memory) Get(_ context.Context, id string) (Principal, error) {
	id = strings.TrimSpace(id)
	if !authz.ValidUUID(id) {
		return Principal{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.byID[id]
	if !ok {
		return Principal{}, ErrNotFound
	}
	return p.clone(), nil
}

func (m *Memory) GetByClientID(_ context.Context, clientID string) (Principal, error) {
	clientID, err := NormalizeClientID(clientID)
	if err != nil {
		return Principal{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byClient[clientID]
	if !ok {
		return Principal{}, ErrNotFound
	}
	return m.byID[id].clone(), nil
}

func (m *Memory) GetByUserID(_ context.Context, userID string) (Principal, error) {
	userID = strings.TrimSpace(userID)
	if !authz.ValidUUID(userID) {
		return Principal{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byUser[userID]
	if !ok {
		return Principal{}, ErrNotFound
	}
	return m.byID[id].clone(), nil
}

func (m *Memory) List(context.Context) ([]Principal, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Principal, 0, len(m.byID))
	for _, p := range m.byID {
		out = append(out, p.clone())
	}
	return out, nil
}

func (m *Memory) Rotate(_ context.Context, id string, rot Rotation) (Principal, error) {
	id = strings.TrimSpace(id)
	if !authz.ValidUUID(id) {
		return Principal{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.byID[id]
	if !ok {
		return Principal{}, ErrNotFound
	}
	if p.Status != StatusActive {
		return Principal{}, ErrRevoked
	}
	next, err := applyRotation(p, rot)
	if err != nil {
		return Principal{}, err
	}
	m.byID[id] = next
	return next.clone(), nil
}

func (m *Memory) Revoke(_ context.Context, id string, now time.Time) (Principal, error) {
	id = strings.TrimSpace(id)
	if !authz.ValidUUID(id) {
		return Principal{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.byID[id]
	if !ok {
		return Principal{}, ErrNotFound
	}
	if p.Status != StatusRevoked {
		now = now.UTC()
		if now.IsZero() {
			now = time.Now().UTC()
		}
		p.Status = StatusRevoked
		p.RevokedAt = &now
		p.UpdatedAt = now
		m.byID[id] = p
	}
	return p.clone(), nil
}

func (m *Memory) ConsumeJTI(_ context.Context, jti, clientID string, retainUntil, now time.Time) error {
	if !validJTI(jti) {
		return ErrInvalid
	}
	if _, err := NormalizeClientID(clientID); err != nil {
		return err
	}
	if retainUntil.IsZero() || now.IsZero() {
		return ErrInvalid
	}
	now = now.UTC()
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, until := range m.jti {
		if !until.After(now) {
			delete(m.jti, id)
		}
	}
	if _, ok := m.jti[jti]; ok {
		return ErrReplay
	}
	m.jti[jti] = retainUntil.UTC()
	return nil
}

func normalizeInput(in Input) (Principal, error) {
	clientID, err := NormalizeClientID(in.ClientID)
	if err != nil {
		return Principal{}, err
	}
	display, err := NormalizeDisplayName(in.DisplayName)
	if err != nil {
		return Principal{}, err
	}
	userID := strings.TrimSpace(in.UserID)
	if !authz.ValidUUID(userID) {
		return Principal{}, ErrInvalid
	}
	if in.SecretHash == "" && len(in.PublicKey) == 0 {
		return Principal{}, ErrInvalid
	}
	if in.SecretHash != "" && (len(in.SecretHash) > 255 || !strings.HasPrefix(in.SecretHash, "$2")) {
		return Principal{}, ErrInvalid
	}
	if len(in.PublicKey) != 0 && len(in.PublicKey) != 32 {
		return Principal{}, ErrInvalid
	}
	bound := strings.TrimSpace(in.WorkspaceID) != ""
	if bound && !authz.ValidUUID(in.WorkspaceID) {
		return Principal{}, ErrInvalid
	}
	if strings.TrimSpace(in.TenantID) != "" && !authz.ValidUUID(in.TenantID) {
		return Principal{}, ErrInvalid
	}
	grants, err := NormalizeGrants(in.Grants, bound)
	if err != nil {
		return Principal{}, err
	}
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	id, err := newUUID()
	if err != nil {
		return Principal{}, err
	}
	return Principal{
		ID:           id,
		UserID:       userID,
		ClientID:     clientID,
		DisplayName:  display,
		Status:       StatusActive,
		Grants:       grants,
		TenantID:     strings.TrimSpace(in.TenantID),
		WorkspaceID:  strings.TrimSpace(in.WorkspaceID),
		WorkbenchKey: strings.TrimSpace(in.WorkbenchKey),
		CreatedAt:    now,
		UpdatedAt:    now,
		secretHash:   in.SecretHash,
		publicKey:    append([]byte(nil), in.PublicKey...),
	}, nil
}

func applyRotation(p Principal, rot Rotation) (Principal, error) {
	if rot.SecretHash == "" && len(rot.PublicKey) == 0 {
		return Principal{}, ErrInvalid
	}
	if rot.SecretHash != "" {
		if len(rot.SecretHash) > 255 || !strings.HasPrefix(rot.SecretHash, "$2") {
			return Principal{}, ErrInvalid
		}
		p.secretHash = rot.SecretHash
	}
	if len(rot.PublicKey) != 0 {
		if len(rot.PublicKey) != 32 {
			return Principal{}, ErrInvalid
		}
		p.publicKey = append([]byte(nil), rot.PublicKey...)
	}
	if !p.hasFactor() {
		return Principal{}, ErrInvalid
	}
	now := rot.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	p.RotatedAt = &now
	p.UpdatedAt = now
	return p, nil
}
