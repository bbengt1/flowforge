package scim

import "strings"

// SCIM_GROUPS_MODE=groups request bodies. A SCIM Group is then a
// Flowforge group in the token's workspace, so it has a display name, an
// optional externalId set on create, and members.

// ManagedGroupWrite is a POST or PUT /Groups body. Members is the full
// member list (user ids); MembersSet is false when the body had no
// members attribute, and a PUT then leaves the members unchanged.
type ManagedGroupWrite struct {
	DisplayName string
	ExternalID  string
	Members     []string
	MembersSet  bool
}

// ManagedGroupPatch is a PatchOp on a managed group. DisplayName is nil
// when not changed. ReplaceMembers with Members replaces the member list
// (Members may be empty); Add and Remove are applied otherwise.
type ManagedGroupPatch struct {
	DisplayName    *string
	ReplaceMembers bool
	Members        []string
	Add            []string
	Remove         []string
}

// ParseManagedGroupWrite reads a Group resource body. displayName is
// required; externalId and members are optional.
func ParseManagedGroupWrite(raw map[string]any) (ManagedGroupWrite, error) {
	if raw == nil || RejectSecrets(raw) {
		return ManagedGroupWrite{}, ErrSecret
	}
	var out ManagedGroupWrite
	name, ok := raw["displayName"].(string)
	if !ok || strings.TrimSpace(name) == "" {
		return ManagedGroupWrite{}, ErrInvalid
	}
	out.DisplayName = strings.TrimSpace(name)
	if v, present := raw["externalId"]; present && v != nil {
		ext, ok := v.(string)
		if !ok {
			return ManagedGroupWrite{}, ErrInvalid
		}
		out.ExternalID = strings.TrimSpace(ext)
	}
	if v, present := raw["members"]; present && v != nil {
		ids, err := memberIDList(v)
		if err != nil {
			return ManagedGroupWrite{}, err
		}
		out.Members = ids
		out.MembersSet = true
	}
	return out, nil
}

// ParseManagedGroupPatch reads a Group PatchOp: replace displayName
// (path displayName, or no path with a {displayName} value), add or
// remove members, or replace members. externalId in a replace is
// accepted and ignored: it is never rewritten after create.
func ParseManagedGroupPatch(raw map[string]any) (ManagedGroupPatch, error) {
	if raw == nil || RejectSecrets(raw) {
		return ManagedGroupPatch{}, ErrSecret
	}
	ops, err := operations(raw)
	if err != nil {
		return ManagedGroupPatch{}, err
	}
	var ch ManagedGroupPatch
	changed := false
	for _, item := range ops {
		opm, ok := item.(map[string]any)
		if !ok {
			return ManagedGroupPatch{}, ErrInvalid
		}
		op := strings.ToLower(strings.TrimSpace(asString(opm["op"])))
		path := strings.TrimSpace(asString(opm["path"]))
		switch op {
		case "replace":
			switch {
			case strings.EqualFold(path, "displayName"):
				name, ok := opm["value"].(string)
				if !ok {
					return ManagedGroupPatch{}, ErrInvalid
				}
				name = strings.TrimSpace(name)
				ch.DisplayName = &name
				changed = true
			case strings.EqualFold(path, "externalId"):
				changed = true
			case membersPath(path):
				ids, err := memberIDList(opm["value"])
				if err != nil {
					return ManagedGroupPatch{}, err
				}
				ch.ReplaceMembers = true
				ch.Members = ids
				ch.Add, ch.Remove = nil, nil
				changed = true
			case path == "":
				m, ok := opm["value"].(map[string]any)
				if !ok {
					return ManagedGroupPatch{}, ErrInvalid
				}
				for key, v := range m {
					switch {
					case strings.EqualFold(key, "displayName"):
						name, ok := v.(string)
						if !ok {
							return ManagedGroupPatch{}, ErrInvalid
						}
						name = strings.TrimSpace(name)
						ch.DisplayName = &name
					case strings.EqualFold(key, "externalId"), strings.EqualFold(key, "id"):
					case strings.EqualFold(key, "members"):
						ids, err := memberIDList(v)
						if err != nil {
							return ManagedGroupPatch{}, err
						}
						ch.ReplaceMembers = true
						ch.Members = ids
						ch.Add, ch.Remove = nil, nil
					default:
						return ManagedGroupPatch{}, ErrInvalid
					}
				}
				changed = true
			default:
				return ManagedGroupPatch{}, ErrInvalid
			}
		case "add":
			if !membersPath(path) {
				return ManagedGroupPatch{}, ErrInvalid
			}
			ids, err := memberIDs(opm["value"])
			if err != nil {
				return ManagedGroupPatch{}, err
			}
			if ch.ReplaceMembers {
				ch.Members = append(ch.Members, ids...)
			} else {
				ch.Add = append(ch.Add, ids...)
			}
			changed = true
		case "remove":
			ids := []string{}
			if id, ok := memberIDFromPath(path); ok {
				ids = append(ids, id)
			} else if membersPath(path) {
				if opm["value"] == nil {
					// Remove every member.
					ch.ReplaceMembers = true
					ch.Members = []string{}
					ch.Add, ch.Remove = nil, nil
					changed = true
					continue
				}
				got, err := memberIDs(opm["value"])
				if err != nil {
					return ManagedGroupPatch{}, err
				}
				ids = got
			} else {
				return ManagedGroupPatch{}, ErrInvalid
			}
			if ch.ReplaceMembers {
				ch.Members = without(ch.Members, ids)
			} else {
				ch.Remove = append(ch.Remove, ids...)
			}
			changed = true
		default:
			return ManagedGroupPatch{}, ErrInvalid
		}
	}
	if !changed {
		return ManagedGroupPatch{}, ErrInvalid
	}
	return ch, nil
}

// memberIDList is memberIDs that also accepts an empty list.
func memberIDList(v any) ([]string, error) {
	if list, ok := v.([]any); ok && len(list) == 0 {
		return []string{}, nil
	}
	return memberIDs(v)
}

func without(list, drop []string) []string {
	gone := map[string]bool{}
	for _, id := range drop {
		gone[strings.ToLower(id)] = true
	}
	out := []string{}
	for _, id := range list {
		if !gone[strings.ToLower(id)] {
			out = append(out, id)
		}
	}
	return out
}
