package scim

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Memory is the in-process directory used by HTTP tests.
type Memory struct {
	mu   sync.Mutex
	rows map[string]Record
}

// NewMemory returns an empty directory.
func NewMemory() *Memory {
	return &Memory{rows: map[string]Record{}}
}

func (m *Memory) Save(_ context.Context, rec Record) error {
	rec, err := normalize(rec)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if prev, ok := m.rows[rec.UserID]; ok && !prev.CreatedAt.IsZero() {
		rec.CreatedAt = prev.CreatedAt
	}
	if rec.Active() {
		for _, other := range m.rows {
			if other.UserID == rec.UserID || !other.Active() {
				continue
			}
			if strings.EqualFold(other.UserName, rec.UserName) {
				return ErrConflict
			}
			if rec.ExternalID != "" && other.ExternalID == rec.ExternalID {
				return ErrConflict
			}
		}
	}
	m.rows[rec.UserID] = rec
	return nil
}

func (m *Memory) Get(_ context.Context, userID string) (Record, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return Record{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.rows[userID]
	if !ok {
		return Record{}, ErrNotFound
	}
	return rec, nil
}

func (m *Memory) FindByUserName(_ context.Context, userName string) (Record, error) {
	userName = strings.TrimSpace(userName)
	if userName == "" {
		return Record{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return preferActive(m.rows, func(rec Record) bool {
		return strings.EqualFold(rec.UserName, userName)
	})
}

func (m *Memory) FindByExternalID(_ context.Context, externalID string) (Record, error) {
	externalID = strings.TrimSpace(externalID)
	if externalID == "" {
		return Record{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return preferActive(m.rows, func(rec Record) bool {
		return rec.ExternalID == externalID
	})
}

func (m *Memory) List(_ context.Context, attr, value string, startIndex, count int) ([]Record, int, error) {
	if startIndex < 1 || count < 0 {
		return nil, 0, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var matched []Record
	for _, rec := range m.rows {
		if !rec.Active() || !matchAttr(rec, attr, value) {
			continue
		}
		matched = append(matched, rec)
	}
	sortRecords(matched)
	total := len(matched)
	if count == 0 || startIndex > total {
		return nil, total, nil
	}
	offset := startIndex - 1
	end := offset + count
	if end > total {
		end = total
	}
	return append([]Record(nil), matched[offset:end]...), total, nil
}

func preferActive(rows map[string]Record, match func(Record) bool) (Record, error) {
	var found Record
	var ok bool
	for _, rec := range rows {
		if !match(rec) {
			continue
		}
		if rec.Active() {
			return rec, nil
		}
		if !ok || rec.UpdatedAt.After(found.UpdatedAt) {
			found = rec
			ok = true
		}
	}
	if !ok {
		return Record{}, ErrNotFound
	}
	return found, nil
}

func matchAttr(rec Record, attr, value string) bool {
	switch attr {
	case "":
		return true
	case "userName":
		return strings.EqualFold(rec.UserName, value)
	case "externalId":
		return rec.ExternalID == value
	case "id":
		return rec.UserID == value
	default:
		return false
	}
}

func sortRecords(in []Record) {
	for i := 1; i < len(in); i++ {
		j := i
		for j > 0 && recordLess(in[j], in[j-1]) {
			in[j], in[j-1] = in[j-1], in[j]
			j--
		}
	}
}

func recordLess(a, b Record) bool {
	if a.CreatedAt.Equal(b.CreatedAt) {
		return a.UserID < b.UserID
	}
	return a.CreatedAt.Before(b.CreatedAt)
}

func normalize(rec Record) (Record, error) {
	rec.UserID = strings.TrimSpace(rec.UserID)
	rec.UserName = strings.TrimSpace(rec.UserName)
	rec.ExternalID = strings.TrimSpace(rec.ExternalID)
	if rec.UserID == "" || rec.UserName == "" || len(rec.UserName) > 256 || len(rec.ExternalID) > 256 {
		return Record{}, ErrInvalid
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	if rec.UpdatedAt.IsZero() {
		rec.UpdatedAt = rec.CreatedAt
	}
	return rec, nil
}
