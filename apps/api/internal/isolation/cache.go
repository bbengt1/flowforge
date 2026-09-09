package isolation

import "sync"

// Cache is an in-process workspace-scoped key/value store. Keys are never
// shared across workspaces; a valid key from another workspace is a miss.
type Cache struct {
	mu   sync.RWMutex
	data map[string]string
}

// NewCache returns an empty workspace cache.
func NewCache() *Cache {
	return &Cache{data: map[string]string{}}
}

func cacheKey(scope Scope, key string) string {
	return scope.TenantID() + "\x00" + scope.WorkbenchKey() + "\x00" + scope.WorkspaceID() + "\x00" + key
}

// Get returns the value for key inside scope, or false on a miss.
func (c *Cache) Get(scope Scope, key string) (string, bool) {
	if scope.Zero() || key == "" {
		return "", false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.data[cacheKey(scope, key)]
	return v, ok
}

// Set stores value for key inside scope.
func (c *Cache) Set(scope Scope, key, value string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if key == "" || len(key) > 200 {
		return ErrInvalid
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[cacheKey(scope, key)] = value
	return nil
}
