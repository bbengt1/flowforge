package vault

import (
	"context"
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

type memRow struct {
	meta        Metadata
	ciphertext  []byte
	dekEnvelope []byte
}

// Memory is an in-process encrypted vault used by HTTP unit tests.
type Memory struct {
	keys  Keys
	refs  RefFinder
	now   func() time.Time
	mu    sync.Mutex
	rows  map[string]memRow
	perms map[string][]memPerm
	evts  map[string][]Event
}

type memPerm struct {
	PrincipalType string
	PrincipalID   string
	Permission    string
}

// NewMemory returns an empty vault. keys must be Ready for write/unlock.
func NewMemory(keys Keys, refs RefFinder) *Memory {
	return &Memory{
		keys:  keys,
		refs:  refs,
		now:   func() time.Time { return time.Now().UTC() },
		rows:  map[string]memRow{},
		perms: map[string][]memPerm{},
		evts:  map[string][]Event{},
	}
}

func (m *Memory) Create(_ context.Context, scope isolation.Scope, in CreateInput) (Metadata, error) {
	if scope.Zero() {
		return Metadata{}, ErrNoScope
	}
	plain, fp, meta, err := prepareCreate(in)
	if err != nil {
		return Metadata{}, err
	}
	env, err := Encrypt(m.keys, plain)
	if err != nil {
		return Metadata{}, err
	}
	now := m.now()
	out := meta
	out.ID = newID()
	out.Fingerprint = fp
	out.EncryptionVersion = env.Version
	out.KeyReference = env.KeyRef
	out.Status = StatusActive
	out.LastTestStatus = TestUntested
	out.CreatedBy = scope.ActorID()
	out.UpdatedBy = scope.ActorID()
	out.CreatedAt = now
	out.UpdatedAt = now
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[rowKey(scope, out.ID)] = memRow{meta: out, ciphertext: env.Ciphertext, dekEnvelope: env.DEKEnvelope}
	if scope.ActorID() != "" {
		m.perms[rowKey(scope, out.ID)] = []memPerm{
			{PrincipalType: "user", PrincipalID: scope.ActorID(), Permission: "manage"},
			{PrincipalType: "user", PrincipalID: scope.ActorID(), Permission: "rotate"},
			{PrincipalType: "user", PrincipalID: scope.ActorID(), Permission: "use"},
		}
	}
	m.appendEventLocked(scope, out.ID, EventCreated, map[string]any{"type": out.Type, "fingerprint": out.Fingerprint})
	return cloneMeta(out), nil
}

func (m *Memory) List(_ context.Context, scope isolation.Scope) ([]Metadata, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Metadata
	prefix := scope.WorkspaceID() + "/"
	for key, row := range m.rows {
		if strings.HasPrefix(key, prefix) {
			out = append(out, cloneMeta(row.meta))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].DisplayName < out[j].DisplayName
		}
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	if out == nil {
		out = []Metadata{}
	}
	return out, nil
}

func (m *Memory) Get(_ context.Context, scope isolation.Scope, id string) (Metadata, error) {
	row, err := m.lookup(scope, id)
	if err != nil {
		return Metadata{}, err
	}
	return cloneMeta(row.meta), nil
}

func (m *Memory) Update(_ context.Context, scope isolation.Scope, id string, in UpdateInput) (Metadata, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Metadata{}, err
	}
	meta := row.meta
	if in.DisplayName != nil {
		name, err := normalizeDisplayName(*in.DisplayName)
		if err != nil {
			return Metadata{}, err
		}
		meta.DisplayName = name
	}
	if in.Tags != nil {
		tags, err := sanitizeTags(*in.Tags)
		if err != nil {
			return Metadata{}, err
		}
		meta.Tags = tags
	}
	if in.Metadata != nil {
		md, err := sanitizeMetadata(*in.Metadata)
		if err != nil {
			return Metadata{}, err
		}
		meta.Metadata = md
	}
	if in.ExpiresAt != nil {
		exp, err := parseExpires(*in.ExpiresAt)
		if err != nil {
			return Metadata{}, err
		}
		meta.ExpiresAt = exp
	}
	meta.UpdatedBy = scope.ActorID()
	meta.UpdatedAt = m.now()
	row.meta = meta
	m.rows[rowKey(scope, id)] = row
	m.appendEventLocked(scope, id, EventMetadataUpdated, map[string]any{"displayName": meta.DisplayName})
	return cloneMeta(meta), nil
}

func (m *Memory) Rotate(_ context.Context, scope isolation.Scope, id string, in RotateInput) (Metadata, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Metadata{}, err
	}
	plain, fp, err := canonicalizeSecret(row.meta.Type, in.Secret)
	if err != nil {
		return Metadata{}, err
	}
	env, err := Encrypt(m.keys, plain)
	if err != nil {
		return Metadata{}, err
	}
	now := m.now()
	row.ciphertext = env.Ciphertext
	row.dekEnvelope = env.DEKEnvelope
	row.meta.Fingerprint = fp
	row.meta.EncryptionVersion = env.Version
	row.meta.KeyReference = env.KeyRef
	row.meta.RotatedAt = &now
	row.meta.LastTestStatus = TestUntested
	row.meta.LastTestedAt = nil
	row.meta.LastTestReason = ""
	row.meta.UpdatedBy = scope.ActorID()
	row.meta.UpdatedAt = now
	m.rows[rowKey(scope, id)] = row
	m.appendEventLocked(scope, id, EventRotated, map[string]any{"fingerprint": fp})
	return cloneMeta(row.meta), nil
}

func (m *Memory) Disable(_ context.Context, scope isolation.Scope, id string) (Metadata, error) {
	return m.setStatus(scope, id, StatusDisabled, EventDisabled)
}

func (m *Memory) Enable(_ context.Context, scope isolation.Scope, id string) (Metadata, error) {
	return m.setStatus(scope, id, StatusActive, EventEnabled)
}

func (m *Memory) setStatus(scope isolation.Scope, id, status, event string) (Metadata, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Metadata{}, err
	}
	now := m.now()
	row.meta.Status = status
	if status == StatusDisabled {
		row.meta.DisabledAt = &now
	} else {
		row.meta.DisabledAt = nil
	}
	row.meta.UpdatedBy = scope.ActorID()
	row.meta.UpdatedAt = now
	m.rows[rowKey(scope, id)] = row
	m.appendEventLocked(scope, id, event, map[string]any{"status": status})
	return cloneMeta(row.meta), nil
}

func (m *Memory) Test(ctx context.Context, scope isolation.Scope, id string) (TestResult, Metadata, error) {
	plain, meta, err := m.unlockForUse(scope, id, false)
	checked := m.now()
	if err != nil {
		reason := safeUnlockReason(err)
		status := TestFailed
		if err == ErrNotFound || err == ErrNoScope {
			return TestResult{}, Metadata{}, err
		}
		meta, _ = m.recordTest(scope, id, status, reason, checked)
		return TestResult{Status: status, Reason: reason, CheckedAt: checked}, meta, nil
	}
	status, reason := TestPayload(meta.Type, plain)
	meta, _ = m.recordTest(scope, id, status, reason, checked)
	return TestResult{Status: status, Reason: reason, CheckedAt: checked}, meta, nil
}

func (m *Memory) Use(_ context.Context, scope isolation.Scope, id string) error {
	if _, _, err := m.unlockForUse(scope, id, true); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return err
	}
	now := m.now()
	row.meta.LastUsedAt = &now
	row.meta.LastUsedBy = scope.ActorID()
	row.meta.UseCount++
	m.rows[rowKey(scope, id)] = row
	m.appendEventLocked(scope, id, EventUsed, map[string]any{"outcome": "authorized"})
	return nil
}

func (m *Memory) Usage(ctx context.Context, scope isolation.Scope, id string) (Usage, error) {
	meta, err := m.Get(ctx, scope, id)
	if err != nil {
		return Usage{}, err
	}
	drafts, versions, execs := m.splitRefs(ctx, scope, id)
	return Usage{
		CredentialID: meta.ID,
		LastUsedAt:   meta.LastUsedAt,
		LastUsedBy:   meta.LastUsedBy,
		UseCount:     meta.UseCount,
		Drafts:       drafts,
		Versions:     versions,
		Executions:   execs,
	}, nil
}

func (m *Memory) DeletionImpact(ctx context.Context, scope isolation.Scope, id string) (DeletionImpact, error) {
	meta, err := m.Get(ctx, scope, id)
	if err != nil {
		return DeletionImpact{}, err
	}
	drafts, versions, execs := m.splitRefs(ctx, scope, id)
	impact := DeletionImpact{
		CredentialID:     meta.ID,
		DisplayName:      meta.DisplayName,
		Status:           meta.Status,
		CanDelete:        len(execs) == 0,
		Drafts:           drafts,
		Versions:         versions,
		ActiveExecutions: execs,
	}
	if !impact.CanDelete {
		impact.BlockReason = "An active execution references this credential."
	}
	return impact, nil
}

func (m *Memory) Delete(ctx context.Context, scope isolation.Scope, id string, in DeleteInput) error {
	if !in.Confirm {
		return ErrNotConfirmed
	}
	impact, err := m.DeletionImpact(ctx, scope, id)
	if err != nil {
		return err
	}
	if !impact.CanDelete {
		return ErrInUse
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.lookupLocked(scope, id); err != nil {
		return err
	}
	m.appendEventLocked(scope, id, EventDeleted, map[string]any{"displayName": impact.DisplayName})
	delete(m.rows, rowKey(scope, id))
	delete(m.perms, rowKey(scope, id))
	delete(m.evts, rowKey(scope, id))
	return nil
}

func (m *Memory) Events(_ context.Context, scope isolation.Scope, id string) ([]Event, error) {
	if _, err := m.lookup(scope, id); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	src := m.evts[rowKey(scope, id)]
	out := make([]Event, len(src))
	copy(out, src)
	if out == nil {
		out = []Event{}
	}
	return out, nil
}

func (m *Memory) Unlock(_ context.Context, scope isolation.Scope, id string) ([]byte, error) {
	plain, _, err := m.unlockForUse(scope, id, true)
	return plain, err
}

func (m *Memory) unlockForUse(scope isolation.Scope, id string, enforceActive bool) ([]byte, Metadata, error) {
	m.mu.Lock()
	row, err := m.lookupLocked(scope, id)
	m.mu.Unlock()
	if err != nil {
		return nil, Metadata{}, err
	}
	if enforceActive {
		if row.meta.Status != StatusActive {
			return nil, row.meta, ErrDisabled
		}
		if expired(row.meta.ExpiresAt, m.now()) {
			return nil, row.meta, ErrExpired
		}
	}
	plain, err := Decrypt(m.keys, Envelope{
		Ciphertext:  row.ciphertext,
		DEKEnvelope: row.dekEnvelope,
		KeyRef:      row.meta.KeyReference,
		Version:     row.meta.EncryptionVersion,
	})
	if err != nil {
		return nil, row.meta, err
	}
	return plain, row.meta, nil
}

func (m *Memory) recordTest(scope isolation.Scope, id, status, reason string, at time.Time) (Metadata, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Metadata{}, err
	}
	row.meta.LastTestStatus = status
	row.meta.LastTestedAt = &at
	row.meta.LastTestReason = reason
	row.meta.UpdatedAt = at
	m.rows[rowKey(scope, id)] = row
	m.appendEventLocked(scope, id, EventTested, map[string]any{"status": status, "reason": reason})
	return cloneMeta(row.meta), nil
}

func (m *Memory) splitRefs(ctx context.Context, scope isolation.Scope, id string) (drafts, versions, execs []wfstore.CredentialRef) {
	drafts, versions, execs = []wfstore.CredentialRef{}, []wfstore.CredentialRef{}, []wfstore.CredentialRef{}
	if m.refs == nil {
		return drafts, versions, execs
	}
	found, err := m.refs.FindCredentialRefs(ctx, scope, id)
	if err != nil {
		return drafts, versions, execs
	}
	for _, ref := range found {
		switch ref.Kind {
		case wfstore.CredentialRefDraft:
			drafts = append(drafts, ref)
		case wfstore.CredentialRefVersion:
			versions = append(versions, ref)
		case wfstore.CredentialRefExecution:
			execs = append(execs, ref)
		}
	}
	return drafts, versions, execs
}

func (m *Memory) lookup(scope isolation.Scope, id string) (memRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lookupLocked(scope, id)
}

func (m *Memory) lookupLocked(scope isolation.Scope, id string) (memRow, error) {
	if scope.Zero() {
		return memRow{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return memRow{}, ErrNotFound
	}
	row, ok := m.rows[rowKey(scope, id)]
	if !ok {
		return memRow{}, ErrNotFound
	}
	return row, nil
}

func (m *Memory) appendEventLocked(scope isolation.Scope, credentialID, eventType string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	evt := Event{
		ID:           newID(),
		CredentialID: credentialID,
		EventType:    eventType,
		ActorID:      scope.ActorID(),
		Details:      details,
		OccurredAt:   m.now(),
	}
	key := rowKey(scope, credentialID)
	m.evts[key] = append([]Event{evt}, m.evts[key]...)
}

func prepareCreate(in CreateInput) ([]byte, string, Metadata, error) {
	if !validType(in.Type) {
		return nil, "", Metadata{}, fmt.Errorf("unknown credential type")
	}
	name, err := normalizeDisplayName(in.DisplayName)
	if err != nil {
		return nil, "", Metadata{}, err
	}
	tags, err := sanitizeTags(in.Tags)
	if err != nil {
		return nil, "", Metadata{}, err
	}
	md, err := sanitizeMetadata(in.Metadata)
	if err != nil {
		return nil, "", Metadata{}, err
	}
	if in.Type == TypeSSHPrivateKey {
		if _, ok := md["keyType"]; !ok {
			if kt := deriveSSHKeyType(in.Secret["privateKey"]); kt != "" {
				md["keyType"] = kt
			}
		}
	}
	exp, err := parseExpires(in.ExpiresAt)
	if err != nil {
		return nil, "", Metadata{}, err
	}
	plain, fp, err := canonicalizeSecret(in.Type, in.Secret)
	if err != nil {
		return nil, "", Metadata{}, err
	}
	return plain, fp, Metadata{
		Type:        in.Type,
		DisplayName: name,
		Tags:        tags,
		Metadata:    md,
		ExpiresAt:   exp,
	}, nil
}

func expired(exp *time.Time, now time.Time) bool {
	return exp != nil && !exp.After(now)
}

func safeUnlockReason(err error) string {
	switch {
	case err == nil:
		return "payload shape is valid"
	case err == ErrDisabled:
		return "credential is disabled"
	case err == ErrExpired:
		return "credential is expired"
	case err == ErrKeyUnavailable:
		return "encryption key is not configured"
	case err == ErrDecrypt:
		return "stored payload could not be decrypted"
	default:
		return "credential cannot be tested"
	}
}

func cloneMeta(m Metadata) Metadata {
	out := m
	if out.Tags == nil {
		out.Tags = []string{}
	} else {
		out.Tags = append([]string{}, m.Tags...)
	}
	out.Metadata = cloneStringMap(m.Metadata)
	return out
}

func cloneStringMap(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

func rowKey(scope isolation.Scope, id string) string {
	return scope.WorkspaceID() + "/" + id
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
