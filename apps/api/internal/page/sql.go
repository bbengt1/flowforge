package page

import (
	"strconv"
	"strings"
)

// Place appends v to args and returns its 1-based placeholder index.
func Place(args *[]any, v any) string {
	*args = append(*args, v)
	return strconv.Itoa(len(*args))
}

// Probe is the SQL LIMIT for a bound page: one extra row so the caller
// can tell whether next is non-empty. Unbound queries return 0 (no LIMIT).
func (q Query) Probe() int {
	if !q.Bound || q.Limit < 1 || q.Limit > MaxLimit {
		return 0
	}
	return q.Limit + 1
}

// LimitSQL is " LIMIT $n" or empty when the query is not bound.
func LimitSQL(args *[]any, q Query) string {
	n := q.Probe()
	if n <= 0 {
		return ""
	}
	return " LIMIT $" + Place(args, n)
}

// ILikePattern is a contains-pattern with \, %, and _ escaped.
func ILikePattern(q string) string {
	var b strings.Builder
	b.Grow(len(q) + 2)
	b.WriteByte('%')
	for _, r := range q {
		if r == '\\' || r == '%' || r == '_' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('%')
	return b.String()
}

// SearchPredicate is "(expr ILIKE $n ESCAPE '\\' OR ...)" or empty when q is empty.
// The pattern is a single bound parameter. exprs are SQL expressions, not user input.
func SearchPredicate(args *[]any, q string, exprs ...string) string {
	q = strings.TrimSpace(q)
	if q == "" || len(exprs) == 0 {
		return ""
	}
	p := Place(args, ILikePattern(q))
	parts := make([]string, len(exprs))
	for i, expr := range exprs {
		parts[i] = expr + " ILIKE $" + p + " ESCAPE '\\'"
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

// DescTimePredicate is the keyset for ORDER BY ts DESC, id DESC.
func DescTimePredicate(args *[]any, collection, tsExpr, idExpr, cursor string) (string, error) {
	return timePredicate(args, collection, tsExpr, idExpr, cursor, false)
}

// AscTimePredicate is the keyset for ORDER BY ts ASC, id ASC.
func AscTimePredicate(args *[]any, collection, tsExpr, idExpr, cursor string) (string, error) {
	return timePredicate(args, collection, tsExpr, idExpr, cursor, true)
}

func timePredicate(args *[]any, collection, tsExpr, idExpr, cursor string, asc bool) (string, error) {
	if strings.TrimSpace(cursor) == "" {
		return "", nil
	}
	key, err := Decode(collection, cursor)
	if err != nil {
		return "", err
	}
	if key.S != "" || key.K == "" {
		return "", ErrInvalid
	}
	ts, err := ParseTime(key.K)
	if err != nil {
		return "", err
	}
	pTS := Place(args, ts)
	pID := Place(args, key.ID)
	op := "<"
	if asc {
		op = ">"
	}
	return "(" + tsExpr + " " + op + " $" + pTS + "::timestamptz OR (" + tsExpr + " = $" + pTS + "::timestamptz AND " + idExpr + " " + op + " $" + pID + "::uuid))", nil
}

// DescIntPredicate is the keyset for ORDER BY num DESC, id DESC.
func DescIntPredicate(args *[]any, collection, numExpr, idExpr, cursor string) (string, error) {
	if strings.TrimSpace(cursor) == "" {
		return "", nil
	}
	key, err := Decode(collection, cursor)
	if err != nil {
		return "", err
	}
	if key.S != "" {
		return "", ErrInvalid
	}
	n, err := ParseIntKey(key.K)
	if err != nil {
		return "", err
	}
	pN := Place(args, n)
	pID := Place(args, key.ID)
	return "(" + numExpr + " < $" + pN + "::int OR (" + numExpr + " = $" + pN + "::int AND " + idExpr + " < $" + pID + "::uuid))", nil
}

// AscTextPredicate is the keyset for ORDER BY textExpr ASC, id ASC.
// textExpr must already be the same normalization encoded in the cursor key
// (for folders, lower(name)).
func AscTextPredicate(args *[]any, collection, textExpr, idExpr, cursor string) (string, error) {
	if strings.TrimSpace(cursor) == "" {
		return "", nil
	}
	key, err := Decode(collection, cursor)
	if err != nil {
		return "", err
	}
	if key.S != "" || key.K == "" {
		return "", ErrInvalid
	}
	pK := Place(args, key.K)
	pID := Place(args, key.ID)
	return "(" + textExpr + " > $" + pK + " OR (" + textExpr + " = $" + pK + " AND " + idExpr + " > $" + pID + "::uuid))", nil
}

// DescStartedPredicate is the keyset for
// ORDER BY started DESC NULLS LAST, created DESC, id DESC.
// An empty primary key means the cursor row had a NULL started_at.
func DescStartedPredicate(args *[]any, collection, startedExpr, createdExpr, idExpr, cursor string) (string, error) {
	if strings.TrimSpace(cursor) == "" {
		return "", nil
	}
	key, err := Decode(collection, cursor)
	if err != nil {
		return "", err
	}
	if key.S == "" {
		return "", ErrInvalid
	}
	created, err := ParseTime(key.S)
	if err != nil {
		return "", err
	}
	pCreated := Place(args, created)
	pID := Place(args, key.ID)
	if key.K == "" {
		return "(" + startedExpr + " IS NULL AND (" + createdExpr + " < $" + pCreated + "::timestamptz OR (" + createdExpr + " = $" + pCreated + "::timestamptz AND " + idExpr + " < $" + pID + "::uuid)))", nil
	}
	started, err := ParseTime(key.K)
	if err != nil {
		return "", err
	}
	pStarted := Place(args, started)
	return "(" + startedExpr + " < $" + pStarted + "::timestamptz OR " + startedExpr + " IS NULL OR (" + startedExpr + " = $" + pStarted + "::timestamptz AND (" + createdExpr + " < $" + pCreated + "::timestamptz OR (" + createdExpr + " = $" + pCreated + "::timestamptz AND " + idExpr + " < $" + pID + "::uuid))))", nil
}

// And joins non-empty SQL predicates with AND.
func And(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, " AND ")
}
