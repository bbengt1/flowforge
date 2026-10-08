package approvalgate

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestRegisteredTracksSettler(t *testing.T) {
	saved := settler
	t.Cleanup(func() { settler = saved })

	RegisterSettler(nil)
	if Registered() {
		t.Fatal("Registered() = true with no settler")
	}
	RegisterSettler(func(context.Context, pgx.Tx, string, string, string, string, time.Time) error { return nil })
	if !Registered() {
		t.Fatal("Registered() = false after RegisterSettler")
	}
}

func TestLockSelectedEmptySelectionLocksNothing(t *testing.T) {
	// No tx is touched when nothing is selected (a nil tx would panic).
	gates, err := LockSelected(context.Background(), nil, "6f1c1a52-7c1e-4a43-9a4c-3c3c0d0e2a11", Selection{})
	if err != nil || gates != nil {
		t.Fatalf("LockSelected(empty) = %v, %v", gates, err)
	}
	gates, err = LockSelected(context.Background(), nil, "not-a-uuid", Selection{All: true})
	if err != nil || gates != nil {
		t.Fatalf("LockSelected(bad workspace) = %v, %v", gates, err)
	}
}
