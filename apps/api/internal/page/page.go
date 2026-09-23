// Package page is the shared keyset pagination contract for collection
// list endpoints.
//
// Response shape (always present on paginated lists):
//
//		{"items":[...], "limit":50, "cursor":"", "next":""}
//
//	  - limit: applied page size. Default 50. Values outside 1..100 are rejected.
//	  - cursor: opaque keyset token that produced this page. Empty on the first page.
//	  - next: opaque token for the following page. Empty when this page is the last.
//
// Query `q` is a case-insensitive substring search. Callers choose the
// fields; secret material, ciphertext, and free-form details are not
// search inputs. Invalid limit, cursor, or q fails closed.
package page

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	DefaultLimit = 50
	MaxLimit     = 100
	maxQueryRune = 200
	maxCursorLen = 1024
	maxKeyLen    = 512
)

// Collection tags keep a cursor from one list from selecting rows on another.
const (
	ColWorkflow        = "workflow"
	ColWorkflowVersion = "wfver"
	ColFolder          = "folder"
	ColCredential      = "cred"
	ColCredentialEvent = "credevt"
	ColExecution       = "exec"
	ColMember          = "member"
	ColWorkspace       = "ws"
	ColOps             = "ops"
	ColOpsVersion      = "opsver"
	ColTrigger         = "hook"
	ColSchedule        = "sched"
	ColApproval        = "appr"
	ColAudit           = "audit"
	ColAlert           = "alert"
	ColMachine         = "machine"
)

// ErrInvalid is a fail-closed pagination error (bad limit, cursor, or q).
var ErrInvalid = errors.New("invalid pagination")

// Query is a keyset page request.
// Bound is set by HTTP parsing. A zero Query is an internal full read
// and must not be used for an HTTP collection response.
// Next, when non-nil, receives the following cursor (empty when done).
type Query struct {
	Limit  int
	Cursor string
	Q      string
	Bound  bool
	Next   *string
}

// Key is the stable sort position stored in a cursor.
// K is the primary key, S an optional secondary key, ID the tie-break.
type Key struct {
	K  string
	S  string
	ID string
}

type token struct {
	V  int    `json:"v"`
	C  string `json:"c"`
	K  string `json:"k"`
	S  string `json:"s,omitempty"`
	ID string `json:"id"`
}

var uuidRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Parse reads limit, cursor, and q from a query string.
// Missing limit becomes DefaultLimit. Out-of-range limit, a malformed
// cursor, or an illegal q returns ErrInvalid.
func Parse(values url.Values) (Query, error) {
	q := Query{Bound: true, Limit: DefaultLimit}
	if raw := strings.TrimSpace(values.Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > MaxLimit {
			return Query{}, ErrInvalid
		}
		q.Limit = n
	}
	if cur := strings.TrimSpace(values.Get("cursor")); cur != "" {
		if len(cur) > maxCursorLen {
			return Query{}, ErrInvalid
		}
		if _, err := decodeToken(cur); err != nil {
			return Query{}, ErrInvalid
		}
		q.Cursor = cur
	}
	if search := strings.TrimSpace(values.Get("q")); search != "" {
		if utf8.RuneCountInString(search) > maxQueryRune {
			return Query{}, ErrInvalid
		}
		for _, r := range search {
			if r < 0x20 || r == 0x7f {
				return Query{}, ErrInvalid
			}
		}
		q.Q = search
	}
	return q, nil
}

// Encode builds an opaque cursor for collection at key.
func Encode(collection string, key Key) (string, error) {
	key = normalizeKey(key)
	if !validCollection(collection) || !uuidRE.MatchString(key.ID) {
		return "", ErrInvalid
	}
	if len(key.K) > maxKeyLen || len(key.S) > maxKeyLen {
		return "", ErrInvalid
	}
	raw, err := json.Marshal(token{V: 1, C: collection, K: key.K, S: key.S, ID: key.ID})
	if err != nil {
		return "", ErrInvalid
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// Decode parses a cursor and requires it to belong to collection.
func Decode(collection, raw string) (Key, error) {
	tok, err := decodeToken(raw)
	if err != nil {
		return Key{}, err
	}
	if tok.C != collection || !validCollection(collection) {
		return Key{}, ErrInvalid
	}
	return normalizeKey(Key{K: tok.K, S: tok.S, ID: tok.ID}), nil
}

func decodeToken(raw string) (token, error) {
	if raw == "" || len(raw) > maxCursorLen {
		return token{}, ErrInvalid
	}
	buf, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return token{}, ErrInvalid
	}
	var tok token
	if err := json.Unmarshal(buf, &tok); err != nil {
		return token{}, ErrInvalid
	}
	if tok.V != 1 || !validCollection(tok.C) || !uuidRE.MatchString(tok.ID) {
		return token{}, ErrInvalid
	}
	if len(tok.K) > maxKeyLen || len(tok.S) > maxKeyLen {
		return token{}, ErrInvalid
	}
	return tok, nil
}

func validCollection(c string) bool {
	if c == "" || len(c) > 16 {
		return false
	}
	for _, r := range c {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

func normalizeKey(k Key) Key {
	k.ID = strings.ToLower(strings.TrimSpace(k.ID))
	k.K = strings.TrimSpace(k.K)
	k.S = strings.TrimSpace(k.S)
	return k
}

// TimeKey is a fixed-width UTC nanosecond key. It sorts lexicographically
// in the same order as time. The zero time is an empty key (SQL NULL).
func TimeKey(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	n := t.UTC().UnixNano()
	if n < 0 {
		return ""
	}
	return sprintfPad(n)
}

func sprintfPad(n int64) string {
	s := strconv.FormatInt(n, 10)
	if len(s) >= 20 {
		return s
	}
	return strings.Repeat("0", 20-len(s)) + s
}

// IntKey is a fixed-width non-negative integer key.
func IntKey(n int) string {
	if n < 0 {
		return ""
	}
	return sprintfPad(int64(n))
}

// ParseTime reverses TimeKey. An empty key is not a timestamp.
func ParseTime(k string) (time.Time, error) {
	if len(k) == 0 || len(k) > 20 {
		return time.Time{}, ErrInvalid
	}
	for _, r := range k {
		if r < '0' || r > '9' {
			return time.Time{}, ErrInvalid
		}
	}
	n, err := strconv.ParseInt(k, 10, 64)
	if err != nil || n < 0 {
		return time.Time{}, ErrInvalid
	}
	return time.Unix(0, n).UTC(), nil
}

// ParseIntKey reverses IntKey.
func ParseIntKey(k string) (int, error) {
	if k == "" || len(k) > 20 {
		return 0, ErrInvalid
	}
	n, err := strconv.ParseInt(k, 10, 64)
	// version_number is a PostgreSQL integer, and the keyset value is a Go int.
	// Reject anything outside that range before the conversion.
	if err != nil || n < 0 || n > math.MaxInt32 {
		return 0, ErrInvalid
	}
	return int(n), nil
}

// Hit reports whether q is empty or a case-insensitive substring of any field.
func Hit(q string, fields ...string) bool {
	q = strings.TrimSpace(q)
	if q == "" {
		return true
	}
	needle := strings.ToLower(q)
	for _, f := range fields {
		if strings.Contains(strings.ToLower(f), needle) {
			return true
		}
	}
	return false
}

// Remember writes next into q.Next when the caller provided a slot.
func Remember(q Query, next string) {
	if q.Next != nil {
		*q.Next = next
	}
}

// Select filters, orders, and keyset-pages an in-memory collection.
// desc orders by K, then S, then ID descending. The cursor row itself
// is not repeated.
func Select[T any](collection string, q Query, desc bool, rows []T, key func(T) Key, match func(T) bool) ([]T, string, error) {
	if !q.Bound {
		if rows == nil {
			return []T{}, "", nil
		}
		return rows, "", nil
	}
	if q.Limit < 1 || q.Limit > MaxLimit {
		return nil, "", ErrInvalid
	}
	var cur Key
	hasCur := false
	if q.Cursor != "" {
		decoded, err := Decode(collection, q.Cursor)
		if err != nil {
			return nil, "", err
		}
		cur = decoded
		hasCur = true
	}
	filtered := make([]T, 0, len(rows))
	for _, row := range rows {
		if match != nil && !match(row) {
			continue
		}
		filtered = append(filtered, row)
	}
	sort.Slice(filtered, func(i, j int) bool {
		c := cmpKey(normalizeKey(key(filtered[i])), normalizeKey(key(filtered[j])))
		if desc {
			return c > 0
		}
		return c < 0
	})
	if hasCur {
		rest := filtered[:0]
		for _, row := range filtered {
			c := cmpKey(normalizeKey(key(row)), cur)
			keep := c > 0
			if desc {
				keep = c < 0
			}
			if keep {
				rest = append(rest, row)
			}
		}
		filtered = rest
	}
	return trimSorted(collection, q, filtered, key)
}

// Trim keeps at most q.Limit rows from an already ordered, cursor-applied
// slice. A longer slice means the caller fetched one extra probe row.
func Trim[T any](collection string, q Query, rows []T, key func(T) Key) ([]T, string, error) {
	if !q.Bound {
		if rows == nil {
			rows = []T{}
		}
		return rows, "", nil
	}
	if q.Limit < 1 || q.Limit > MaxLimit {
		return nil, "", ErrInvalid
	}
	return trimSorted(collection, q, rows, key)
}

func trimSorted[T any](collection string, q Query, rows []T, key func(T) Key) ([]T, string, error) {
	next := ""
	if len(rows) > q.Limit {
		encoded, err := Encode(collection, key(rows[q.Limit-1]))
		if err != nil {
			return nil, "", err
		}
		next = encoded
		rows = append([]T(nil), rows[:q.Limit]...)
	}
	if rows == nil {
		rows = []T{}
	}
	return rows, next, nil
}

func cmpKey(a, b Key) int {
	if a.K != b.K {
		if a.K < b.K {
			return -1
		}
		return 1
	}
	if a.S != b.S {
		if a.S < b.S {
			return -1
		}
		return 1
	}
	if a.ID != b.ID {
		if a.ID < b.ID {
			return -1
		}
		return 1
	}
	return 0
}
