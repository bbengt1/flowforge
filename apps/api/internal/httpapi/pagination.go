package httpapi

import (
	"errors"
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/page"
)

// pageResponse is the collection envelope for Chloe.
// items is never null. limit is the applied page size.
// cursor is the opaque token that produced this page (empty on the first page).
// next is the opaque token for the following page (empty when this page is the last).
type pageResponse[T any] struct {
	Items  []T    `json:"items"`
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
	Next   string `json:"next"`
}

func parsePage(w http.ResponseWriter, r *http.Request) (page.Query, bool) {
	q, err := page.Parse(r.URL.Query())
	if err != nil {
		rejectPageErr(w, r, err)
		return page.Query{}, false
	}
	return q, true
}

// rejectPageErr writes a static 400 when err is a pagination failure.
// The problem body does not echo q or the cursor.
func rejectPageErr(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil || !errors.Is(err, page.ErrInvalid) {
		return false
	}
	WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "limit, cursor, or q is not valid.")
	return true
}

func writePage[T any](w http.ResponseWriter, items []T, q page.Query, next string) {
	if items == nil {
		items = []T{}
	}
	writeJSON(w, http.StatusOK, pageResponse[T]{
		Items:  items,
		Limit:  q.Limit,
		Cursor: q.Cursor,
		Next:   next,
	})
}
