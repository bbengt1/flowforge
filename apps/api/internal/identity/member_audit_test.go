package identity

import (
	"context"
	"errors"
	"testing"
)

// Every role audit row needs exactly one actor: a session user, a SCIM
// token, or a named non-user path. Anything else is refused before any
// role is written.
func TestMemberActorValid(t *testing.T) {
	const id = "8a6e0f5c-1b2d-4c3e-9f40-5a6b7c8d9e0f"
	cases := []struct {
		name  string
		actor MemberActor
		want  bool
	}{
		{"session user", MemberActor{UserID: id}, true},
		{"workspace scim token", MemberActor{SCIMTokenID: id}, true},
		{"instance scim token", MemberActor{Via: MemberViaSCIMInstanceToken}, true},
		{"system", MemberActor{Via: MemberViaSystem}, true},
		{"request id alone is not an actor", MemberActor{RequestID: "req-1"}, false},
		{"empty", MemberActor{}, false},
		{"user id not a uuid", MemberActor{UserID: "alice"}, false},
		{"token id not a uuid", MemberActor{SCIMTokenID: "ffscim_secret"}, false},
		{"via scim_token needs the token id field", MemberActor{Via: MemberViaSCIMToken}, false},
		{"unknown via", MemberActor{Via: "worker"}, false},
		{"two actors", MemberActor{UserID: id, SCIMTokenID: id}, false},
		{"user and via", MemberActor{UserID: id, Via: MemberViaSystem}, false},
	}
	for _, c := range cases {
		if got := c.actor.Valid(); got != c.want {
			t.Errorf("%s: Valid() = %v, want %v", c.name, got, c.want)
		}
	}
}

// The memory store refuses a role write with no actor, matching Postgres.
func TestMemoryMemberWritesNeedAnActor(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	if err := m.SetMemberRoles(ctx, "ws", "u", []string{"viewer"}, MemberActor{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("SetMemberRoles without actor = %v, want ErrInvalid", err)
	}
	if err := m.RemoveMember(ctx, "ws", "u", MemberActor{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("RemoveMember without actor = %v, want ErrInvalid", err)
	}
}
