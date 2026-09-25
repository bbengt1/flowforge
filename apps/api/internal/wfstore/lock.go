package wfstore

import "context"

type workflowRowLockHookKey struct{}

// WithWorkflowRowLockHook runs hook while the workflow row lock is held
// and before the locked operation mutates. Tests use it to start the other
// side of the delete/start race. The hook must not re-enter the same store
// on the calling goroutine.
func WithWorkflowRowLockHook(ctx context.Context, hook func()) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, workflowRowLockHookKey{}, hook)
}

func runWorkflowRowLockHook(ctx context.Context) {
	if ctx == nil {
		return
	}
	hook, _ := ctx.Value(workflowRowLockHookKey{}).(func())
	if hook != nil {
		hook()
	}
}
