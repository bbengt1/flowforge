package artifact

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

// ErrNotFound is returned when an object is missing.
var ErrNotFound = errors.New("artifact object not found")

// Objects is encrypted-at-rest object storage. Implementations never expose
// bucket credentials or list other workspace prefixes to callers.
type Objects interface {
	Put(workspaceID, ref string, ciphertext []byte) error
	Get(workspaceID, ref string) ([]byte, error)
	Delete(workspaceID, ref string) error
}

// MemoryObjects is an in-process store used by unit tests.
type MemoryObjects struct {
	mu   sync.Mutex
	data map[string][]byte
}

// NewMemoryObjects returns an empty memory object store.
func NewMemoryObjects() *MemoryObjects {
	return &MemoryObjects{data: map[string][]byte{}}
}

func (m *MemoryObjects) key(workspaceID, ref string) string {
	return workspaceID + "/" + ref
}

// Put stores ciphertext for a workspace-scoped opaque ref.
func (m *MemoryObjects) Put(workspaceID, ref string, ciphertext []byte) error {
	if err := validateLocator(workspaceID, ref); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[m.key(workspaceID, ref)] = append([]byte(nil), ciphertext...)
	return nil
}

// Get returns ciphertext for a workspace-scoped opaque ref.
func (m *MemoryObjects) Get(workspaceID, ref string) ([]byte, error) {
	if err := validateLocator(workspaceID, ref); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	raw, ok := m.data[m.key(workspaceID, ref)]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), raw...), nil
}

// Delete removes ciphertext. Missing keys are not an error.
func (m *MemoryObjects) Delete(workspaceID, ref string) error {
	if err := validateLocator(workspaceID, ref); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, m.key(workspaceID, ref))
	return nil
}

// FilesystemObjects stores ciphertext under {Root}/{workspaceID}/{ref}.
// Root must be a dedicated directory; refs are UUID-shaped and cannot escape.
type FilesystemObjects struct {
	Root string
}

// NewFilesystemObjects prepares a directory-backed store.
func NewFilesystemObjects(root string) (*FilesystemObjects, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("ARTIFACT_STORE_DIR is empty")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &FilesystemObjects{Root: root}, nil
}

func (f *FilesystemObjects) path(workspaceID, ref string) (string, error) {
	if err := validateLocator(workspaceID, ref); err != nil {
		return "", err
	}
	dir := filepath.Join(f.Root, workspaceID)
	return filepath.Join(dir, ref), nil
}

// Put writes ciphertext using restrictive permissions.
func (f *FilesystemObjects) Put(workspaceID, ref string, ciphertext []byte) error {
	path, err := f.path(workspaceID, ref)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, ciphertext, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Get reads ciphertext.
func (f *FilesystemObjects) Get(workspaceID, ref string) ([]byte, error) {
	path, err := f.path(workspaceID, ref)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return raw, nil
}

// Delete removes the object file.
func (f *FilesystemObjects) Delete(workspaceID, ref string) error {
	path, err := f.path(workspaceID, ref)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func validateLocator(workspaceID, ref string) error {
	if !safePathPart(workspaceID) || !safePathPart(ref) {
		return errors.New("invalid artifact locator")
	}
	return nil
}

func safePathPart(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, `/\`) {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}

// Seal encrypts plaintext with the process KEK. The returned envelope
// ciphertext is what belongs in object storage.
func Seal(keys vault.Keys, plaintext []byte) (vault.Envelope, string, error) {
	env, err := vault.Encrypt(keys, plaintext)
	if err != nil {
		return vault.Envelope{}, "", err
	}
	sum := sha256.Sum256(plaintext)
	return env, "sha256:" + hex.EncodeToString(sum[:]), nil
}

// Open decrypts an envelope recovered from metadata + object bytes.
func Open(keys vault.Keys, env vault.Envelope) ([]byte, error) {
	return vault.Decrypt(keys, env)
}

// LoadObjects returns a filesystem store when ARTIFACT_STORE_DIR is set,
// otherwise an in-process memory store (tests / ephemeral local MVP).
func LoadObjects() (Objects, string, error) {
	root := strings.TrimSpace(os.Getenv("ARTIFACT_STORE_DIR"))
	if root == "" {
		return NewMemoryObjects(), "memory", nil
	}
	fs, err := NewFilesystemObjects(root)
	if err != nil {
		return nil, "", err
	}
	return fs, root, nil
}
