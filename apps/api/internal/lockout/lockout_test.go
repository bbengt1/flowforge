package lockout

import (
	"testing"
	"time"
)

func TestMemoryLockSurvivesReuse(t *testing.T) {
	store := NewMemory()
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	first, err := store.NoteFailure(t.Context(), "user-1", 2, now)
	if err != nil || first.Locked() || first.Failed != 1 {
		t.Fatalf("first: %+v %v", first, err)
	}
	second, err := store.NoteFailure(t.Context(), "user-1", 2, now.Add(time.Second))
	if err != nil || !second.Locked() || second.Failed != 2 {
		t.Fatalf("second: %+v %v", second, err)
	}
	again, err := store.NoteFailure(t.Context(), "user-1", 2, now.Add(2*time.Second))
	if err != nil || again.Failed != 2 || !again.Locked() {
		t.Fatalf("capped: %+v %v", again, err)
	}
	restarted := store
	got, err := restarted.Get(t.Context(), "user-1")
	if err != nil || !got.Locked() {
		t.Fatalf("reused store lost the lock: %+v %v", got, err)
	}
	fresh := NewMemory()
	empty, err := fresh.Get(t.Context(), "user-1")
	if err != nil || empty.Locked() || empty.Failed != 0 {
		t.Fatalf("new store must not see another process memory: %+v %v", empty, err)
	}
	if err := restarted.Unlock(t.Context(), "user-1"); err != nil {
		t.Fatal(err)
	}
	cleared, err := store.Get(t.Context(), "user-1")
	if err != nil || cleared.Locked() || cleared.Failed != 0 {
		t.Fatalf("unlock: %+v %v", cleared, err)
	}
}

func TestLoadMaxFailuresFailClosed(t *testing.T) {
	t.Setenv(EnvMaxFailures, "")
	n, err := LoadMaxFailures()
	if err != nil || n != DefaultMaxFailures {
		t.Fatalf("default: %d %v", n, err)
	}
	for _, raw := range []string{"0", "-1", "abc", "51"} {
		t.Setenv(EnvMaxFailures, raw)
		if _, err := LoadMaxFailures(); err == nil {
			t.Fatalf("%s was accepted", raw)
		}
	}
	t.Setenv(EnvMaxFailures, "3")
	n, err = LoadMaxFailures()
	if err != nil || n != 3 {
		t.Fatalf("3: %d %v", n, err)
	}
}
