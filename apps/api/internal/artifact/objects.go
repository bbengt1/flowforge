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

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

// ErrNotFound is returned when an object is missing.
var ErrNotFound = errors.New("artifact object not found")

// Objects is encrypted-at-rest object storage. Keys are
// {tenantID}/{workspaceID}/{ref}, each a server UUID. Implementations
// never put filenames, credentials, or caller metadata on the object,
// and never expose bucket credentials.
type Objects interface {
	Put(tenantID, workspaceID, ref string, ciphertext []byte) error
	Get(tenantID, workspaceID, ref string) ([]byte, error)
	Delete(tenantID, workspaceID, ref string) error
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

// Put stores ciphertext for a tenant- and workspace-scoped opaque ref.
func (m *MemoryObjects) Put(tenantID, workspaceID, ref string, ciphertext []byte) error {
	key, err := scopedObjectKey(tenantID, workspaceID, ref)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = append([]byte(nil), ciphertext...)
	return nil
}

// Get returns ciphertext for a tenant- and workspace-scoped opaque ref.
func (m *MemoryObjects) Get(tenantID, workspaceID, ref string) ([]byte, error) {
	key, err := scopedObjectKey(tenantID, workspaceID, ref)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	raw, ok := m.data[key]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), raw...), nil
}

// Delete removes ciphertext. Missing keys are not an error.
func (m *MemoryObjects) Delete(tenantID, workspaceID, ref string) error {
	key, err := scopedObjectKey(tenantID, workspaceID, ref)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return nil
}

// FilesystemObjects stores ciphertext under {Root}/{tenantID}/{workspaceID}/{ref}.
// Root must be a dedicated directory. All three key parts are UUIDs and cannot escape.
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

func (f *FilesystemObjects) path(tenantID, workspaceID, ref string) (string, error) {
	key, err := scopedObjectKey(tenantID, workspaceID, ref)
	if err != nil {
		return "", err
	}
	return filepath.Join(f.Root, filepath.FromSlash(key)), nil
}

// Put writes ciphertext using restrictive permissions.
func (f *FilesystemObjects) Put(tenantID, workspaceID, ref string, ciphertext []byte) error {
	path, err := f.path(tenantID, workspaceID, ref)
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
func (f *FilesystemObjects) Get(tenantID, workspaceID, ref string) ([]byte, error) {
	path, err := f.path(tenantID, workspaceID, ref)
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
func (f *FilesystemObjects) Delete(tenantID, workspaceID, ref string) error {
	path, err := f.path(tenantID, workspaceID, ref)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// scopedObjectKey is the only object-key shape: three lowercase UUIDs.
// Filenames, prefixes, and credentials are rejected.
func scopedObjectKey(tenantID, workspaceID, ref string) (string, error) {
	tenantID = strings.ToLower(strings.TrimSpace(tenantID))
	workspaceID = strings.ToLower(strings.TrimSpace(workspaceID))
	ref = strings.ToLower(strings.TrimSpace(ref))
	if !authz.ValidUUID(tenantID) || !authz.ValidUUID(workspaceID) || !authz.ValidUUID(ref) {
		return "", errors.New("invalid artifact locator")
	}
	return tenantID + "/" + workspaceID + "/" + ref, nil
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

// errStoreUnavailable is returned when no durable store was configured.
// The text never names a path, bucket, or credential.
var errStoreUnavailable = errors.New("artifact object store is not configured")

// UnavailableObjects refuses every read and write. The HTTP server uses
// this when ARTIFACT_STORE_DIR is set on a production-locked process and
// no store was injected, so a directory is not a silent fallback.
func UnavailableObjects() Objects {
	return unavailableObjects{}
}

type unavailableObjects struct{}

func (unavailableObjects) Put(string, string, string, []byte) error {
	return errStoreUnavailable
}

func (unavailableObjects) Get(string, string, string) ([]byte, error) {
	return nil, errStoreUnavailable
}

func (unavailableObjects) Delete(string, string, string) error {
	return errStoreUnavailable
}

// Backend selection lives in LoadStore. Filesystem and memory stores are
// non-production. A production-locked process requires S3.
