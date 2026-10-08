package scim

import (
	"errors"
	"testing"
)

func TestParseManagedGroupWrite(t *testing.T) {
	in, err := ParseManagedGroupWrite(map[string]any{"displayName": " Finance ", "externalId": "ext-1", "members": []any{map[string]any{"value": "u1"}}})
	if err != nil || in.DisplayName != "Finance" || in.ExternalID != "ext-1" || len(in.Members) != 1 || !in.MembersSet {
		t.Fatalf("write = %+v %v", in, err)
	}
	in, err = ParseManagedGroupWrite(map[string]any{"displayName": "No members"})
	if err != nil || in.MembersSet {
		t.Fatalf("no members = %+v %v", in, err)
	}
	in, err = ParseManagedGroupWrite(map[string]any{"displayName": "Empty", "members": []any{}})
	if err != nil || !in.MembersSet || len(in.Members) != 0 {
		t.Fatalf("empty members = %+v %v", in, err)
	}
	for _, bad := range []map[string]any{{}, {"displayName": ""}, {"displayName": 3}, {"displayName": "x", "externalId": 1}} {
		if _, err := ParseManagedGroupWrite(bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%v: %v", bad, err)
		}
	}
	if _, err := ParseManagedGroupWrite(map[string]any{"displayName": "x", "password": "p"}); !errors.Is(err, ErrSecret) {
		t.Fatalf("secret: %v", err)
	}
}

func TestParseManagedGroupPatch(t *testing.T) {
	op := func(ops ...any) map[string]any { return map[string]any{"Operations": ops} }
	ch, err := ParseManagedGroupPatch(op(
		map[string]any{"op": "replace", "path": "displayName", "value": " New "},
		map[string]any{"op": "add", "path": "members", "value": []any{map[string]any{"value": "a"}}},
		map[string]any{"op": "remove", "path": `members[value eq "b"]`},
	))
	if err != nil || ch.DisplayName == nil || *ch.DisplayName != "New" || len(ch.Add) != 1 || len(ch.Remove) != 1 || ch.ReplaceMembers {
		t.Fatalf("patch = %+v %v", ch, err)
	}
	ch, err = ParseManagedGroupPatch(op(map[string]any{"op": "replace", "value": map[string]any{"displayName": "Okta", "externalId": "ignored"}}))
	if err != nil || ch.DisplayName == nil || *ch.DisplayName != "Okta" {
		t.Fatalf("no-path replace = %+v %v", ch, err)
	}
	ch, err = ParseManagedGroupPatch(op(map[string]any{"op": "replace", "path": "members", "value": []any{}}))
	if err != nil || !ch.ReplaceMembers || len(ch.Members) != 0 {
		t.Fatalf("replace members = %+v %v", ch, err)
	}
	ch, err = ParseManagedGroupPatch(op(map[string]any{"op": "remove", "path": "members"}))
	if err != nil || !ch.ReplaceMembers || len(ch.Members) != 0 {
		t.Fatalf("remove all = %+v %v", ch, err)
	}
	for _, bad := range []map[string]any{
		op(),
		op(map[string]any{"op": "replace", "path": "roles", "value": "x"}),
		op(map[string]any{"op": "add", "path": "displayName", "value": "x"}),
		op(map[string]any{"op": "move", "path": "members"}),
	} {
		if _, err := ParseManagedGroupPatch(bad); err == nil {
			t.Fatalf("%v accepted", bad)
		}
	}
}
