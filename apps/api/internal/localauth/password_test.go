package localauth

import (
	"strings"
	"testing"
)

func TestNormalizeIdentifier(t *testing.T) {
	got, err := NormalizeIdentifier("  Admin@Example.COM ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "admin@example.com" {
		t.Fatalf("got %q", got)
	}
	if _, err := NormalizeIdentifier(""); err != ErrInvalidIdentifier {
		t.Fatalf("empty = %v", err)
	}
	if _, err := NormalizeIdentifier("admin name"); err != ErrInvalidIdentifier {
		t.Fatalf("space = %v", err)
	}
}

func TestHashAndVerify(t *testing.T) {
	hash, err := HashPassword("correct-horse")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "" || strings.Contains(hash, "correct-horse") {
		t.Fatal("hash must not contain the password")
	}
	if !Verify("correct-horse", hash) {
		t.Fatal("expected match")
	}
	if Verify("wrong-password", hash) {
		t.Fatal("wrong password must fail")
	}
	if Verify("correct-horse", "") {
		t.Fatal("empty hash must fail")
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("short"); err != ErrInvalidPassword {
		t.Fatalf("short = %v", err)
	}
	if err := ValidatePassword(strings.Repeat("a", MaxPasswordLength+1)); err != ErrInvalidPassword {
		t.Fatalf("long = %v", err)
	}
	if err := ValidatePassword("long-enough"); err != nil {
		t.Fatal(err)
	}
}

func TestDummyVerifyDoesNotPanic(t *testing.T) {
	DummyVerify("anything-at-all")
}
