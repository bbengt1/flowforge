package opsconfig

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestMapDBErrKeepsPrivilegeCode(t *testing.T) {
	raw := &pgconn.PgError{Code: "42501", Message: "permission denied"}
	err := mapDBErr(raw)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("not found = %v", err)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("code = %v", err)
	}
	plain := mapDBErr(&pgconn.PgError{Code: "22P02", Message: "invalid text representation"})
	if !errors.Is(plain, ErrNotFound) {
		t.Fatalf("22P02 = %v", plain)
	}
	var leaked *pgconn.PgError
	if errors.As(plain, &leaked) {
		t.Fatalf("22P02 leaked code %s", leaked.Code)
	}
}
