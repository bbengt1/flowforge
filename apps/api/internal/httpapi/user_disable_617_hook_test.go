package httpapi

import "github.com/bbengt1/flowforge/apps/api/internal/identity"

// installDisableRecheckHook wraps the test-only identity hook so the
// #617 tests that need it can be skipped when run against code without it.
func installDisableRecheckHook(fn func(workspaceID string) error) (restore func()) {
	return identity.SetDisableRecheckHookForTest(fn)
}
