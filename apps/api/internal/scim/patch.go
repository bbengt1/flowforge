package scim

import "strings"

// UserChange is a create, replace, or patch of a User. Nil pointers
// were omitted. ExternalID empty with the pointer set means the client
// sent an empty externalId.
type UserChange struct {
	UserName    *string
	DisplayName *string
	Active      *bool
	ExternalID  *string
}

// GroupChange is a membership patch. Replace of the whole member list
// is rejected by the parser.
type GroupChange struct {
	Add    []string
	Remove []string
}

// RejectSecrets reports whether v carries a password or other secret field.
func RejectSecrets(v any) bool {
	switch t := v.(type) {
	case map[string]any:
		for key, child := range t {
			if secretKey(key) || RejectSecrets(child) {
				return true
			}
		}
	case []any:
		for _, child := range t {
			if RejectSecrets(child) {
				return true
			}
		}
	}
	return false
}

func secretKey(key string) bool {
	n := strings.ToLower(strings.ReplaceAll(key, "-", "_"))
	switch n {
	case "password", "password_hash", "passwd", "secret", "secrets", "token",
		"bearer", "client_secret", "access_token", "refresh_token", "assertion",
		"private_key", "privatekey", "ciphertext", "kek":
		return true
	default:
		return strings.Contains(n, "password") || strings.Contains(n, "secret")
	}
}

// ParseUserWrite reads a User resource body.
func ParseUserWrite(raw map[string]any) (UserChange, error) {
	if raw == nil || RejectSecrets(raw) {
		return UserChange{}, ErrSecret
	}
	var ch UserChange
	if err := fillUser(&ch, "", raw); err != nil {
		return UserChange{}, err
	}
	if ch.UserName == nil {
		if email := primaryEmail(raw["emails"]); email != "" {
			ch.UserName = &email
		}
	}
	if ch.DisplayName == nil {
		if name := formattedName(raw["name"]); name != "" {
			ch.DisplayName = &name
		}
	}
	return ch, nil
}

// ParseUserPatch reads a PatchOp body.
func ParseUserPatch(raw map[string]any) (UserChange, error) {
	if raw == nil || RejectSecrets(raw) {
		return UserChange{}, ErrSecret
	}
	ops, err := operations(raw)
	if err != nil {
		return UserChange{}, err
	}
	var ch UserChange
	for _, item := range ops {
		opm, ok := item.(map[string]any)
		if !ok || RejectSecrets(opm) {
			if ok {
				return UserChange{}, ErrSecret
			}
			return UserChange{}, ErrInvalid
		}
		op := strings.ToLower(strings.TrimSpace(asString(opm["op"])))
		if op != "replace" && op != "add" {
			return UserChange{}, ErrInvalid
		}
		path := strings.TrimSpace(asString(opm["path"]))
		if err := fillUser(&ch, path, opm["value"]); err != nil {
			return UserChange{}, err
		}
	}
	return ch, nil
}

// ParseGroupPatch reads a Group PatchOp limited to member add/remove.
func ParseGroupPatch(raw map[string]any) (GroupChange, error) {
	if raw == nil || RejectSecrets(raw) {
		return GroupChange{}, ErrSecret
	}
	ops, err := operations(raw)
	if err != nil {
		return GroupChange{}, err
	}
	var ch GroupChange
	for _, item := range ops {
		opm, ok := item.(map[string]any)
		if !ok || RejectSecrets(opm) {
			if ok {
				return GroupChange{}, ErrSecret
			}
			return GroupChange{}, ErrInvalid
		}
		op := strings.ToLower(strings.TrimSpace(asString(opm["op"])))
		path := strings.TrimSpace(asString(opm["path"]))
		switch op {
		case "add":
			if !membersPath(path) {
				return GroupChange{}, ErrInvalid
			}
			ids, err := memberIDs(opm["value"])
			if err != nil {
				return GroupChange{}, err
			}
			ch.Add = append(ch.Add, ids...)
		case "remove":
			if id, ok := memberIDFromPath(path); ok {
				ch.Remove = append(ch.Remove, id)
				continue
			}
			if !membersPath(path) {
				return GroupChange{}, ErrInvalid
			}
			ids, err := memberIDs(opm["value"])
			if err != nil {
				return GroupChange{}, err
			}
			ch.Remove = append(ch.Remove, ids...)
		default:
			return GroupChange{}, ErrInvalid
		}
	}
	if len(ch.Add) == 0 && len(ch.Remove) == 0 {
		return GroupChange{}, ErrInvalid
	}
	return ch, nil
}

// ParseFilter parses `attr eq "value"`. An empty filter lists every resource.
func ParseFilter(raw string) (attr, value string, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", nil
	}
	if len(raw) > 512 {
		return "", "", ErrInvalid
	}
	lower := strings.ToLower(raw)
	idx := strings.Index(lower, " eq ")
	if idx <= 0 {
		return "", "", ErrInvalid
	}
	attr = strings.TrimSpace(raw[:idx])
	rest := strings.TrimSpace(raw[idx+4:])
	switch strings.ToLower(attr) {
	case "username":
		attr = "userName"
	case "externalid":
		attr = "externalId"
	case "displayname":
		attr = "displayName"
	case "id":
		attr = "id"
	default:
		return "", "", ErrInvalid
	}
	if len(rest) >= 2 && rest[0] == '"' && rest[len(rest)-1] == '"' {
		rest = rest[1 : len(rest)-1]
		rest = strings.ReplaceAll(rest, `\"`, `"`)
	}
	rest = strings.TrimSpace(rest)
	if rest == "" || strings.ContainsAny(rest, "\r\n") {
		return "", "", ErrInvalid
	}
	return attr, rest, nil
}

func fillUser(ch *UserChange, path string, value any) error {
	if value == nil {
		return ErrInvalid
	}
	if path == "" {
		raw, ok := value.(map[string]any)
		if !ok {
			return ErrInvalid
		}
		if RejectSecrets(raw) {
			return ErrSecret
		}
		return fillUserMap(ch, raw)
	}
	switch strings.ToLower(path) {
	case "active":
		b, ok := value.(bool)
		if !ok {
			return ErrInvalid
		}
		ch.Active = &b
	case "username":
		s, ok := value.(string)
		if !ok {
			return ErrInvalid
		}
		s = strings.TrimSpace(s)
		ch.UserName = &s
	case "displayname", "name.formatted":
		s, ok := value.(string)
		if !ok {
			return ErrInvalid
		}
		s = strings.TrimSpace(s)
		ch.DisplayName = &s
	case "externalid":
		s, ok := value.(string)
		if !ok {
			return ErrInvalid
		}
		s = strings.TrimSpace(s)
		ch.ExternalID = &s
	case "name":
		name := formattedName(value)
		if name == "" {
			return ErrInvalid
		}
		ch.DisplayName = &name
	default:
		if ignoredUserPath(path) {
			return nil
		}
		return ErrInvalid
	}
	return nil
}

func fillUserMap(ch *UserChange, raw map[string]any) error {
	for key, value := range raw {
		if ignoredUserPath(key) {
			continue
		}
		switch strings.ToLower(key) {
		case "username", "displayname", "externalid", "active", "name":
			if err := fillUser(ch, key, value); err != nil {
				return err
			}
		default:
			if strings.Contains(key, ":") {
				continue
			}
			return ErrInvalid
		}
	}
	return nil
}

func ignoredUserPath(path string) bool {
	switch strings.ToLower(strings.TrimSpace(path)) {
	case "schemas", "id", "meta", "emails", "phonenumbers", "photos", "addresses",
		"groups", "entitlements", "roles", "x509certificates", "ims",
		"locale", "timezone", "title", "nickname", "profileurl",
		"preferredlanguage", "usertype", "name.givenname", "name.familyname",
		"name.middlename", "name.honorificprefix", "name.honorificsuffix":
		return true
	default:
		return false
	}
}

func operations(raw map[string]any) ([]any, error) {
	ops, ok := raw["Operations"].([]any)
	if !ok {
		ops, ok = raw["operations"].([]any)
	}
	if !ok || len(ops) == 0 {
		return nil, ErrInvalid
	}
	return ops, nil
}

func primaryEmail(v any) string {
	list, ok := v.([]any)
	if !ok {
		return ""
	}
	var first string
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		addr := strings.TrimSpace(asString(m["value"]))
		if addr == "" {
			continue
		}
		if first == "" {
			first = addr
		}
		if b, ok := m["primary"].(bool); ok && b {
			return addr
		}
	}
	return first
}

func formattedName(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if s := strings.TrimSpace(asString(m["formatted"])); s != "" {
		return s
	}
	given := strings.TrimSpace(asString(m["givenName"]))
	family := strings.TrimSpace(asString(m["familyName"]))
	return strings.TrimSpace(given + " " + family)
}

func membersPath(path string) bool {
	if path == "" {
		return false
	}
	return strings.EqualFold(path, "members")
}

func memberIDFromPath(path string) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(path))
	const prefix = "members[value eq "
	if !strings.HasPrefix(lower, prefix) || !strings.HasSuffix(lower, "]") {
		return "", false
	}
	inner := strings.TrimSpace(path[len(prefix) : len(path)-1])
	inner = strings.Trim(inner, `"`)
	inner = strings.TrimSpace(inner)
	if inner == "" || strings.ContainsAny(inner, "\"[]") {
		return "", false
	}
	return inner, true
}

func memberIDs(v any) ([]string, error) {
	switch t := v.(type) {
	case string:
		id := strings.TrimSpace(t)
		if id == "" {
			return nil, ErrInvalid
		}
		return []string{id}, nil
	case map[string]any:
		id := strings.TrimSpace(asString(t["value"]))
		if id == "" {
			return nil, ErrInvalid
		}
		return []string{id}, nil
	case []any:
		var out []string
		for _, item := range t {
			ids, err := memberIDs(item)
			if err != nil {
				return nil, err
			}
			out = append(out, ids...)
		}
		if len(out) == 0 {
			return nil, ErrInvalid
		}
		return out, nil
	default:
		return nil, ErrInvalid
	}
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}
