package scim

import (
	"strings"
	"testing"
)

func TestNewTokenFormat(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 32; i++ {
		tok, err := NewToken()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(tok, TokenPrefix) || len(tok) != len(TokenPrefix)+43 || !WellFormedToken(tok) || !IsWorkspaceToken(tok) || !ContainsToken("x "+tok+" y") {
			t.Fatalf("token shape %d", len(tok))
		}
		if seen[tok] {
			t.Fatal("duplicate token")
		}
		seen[tok] = true
		h := HashToken(tok)
		if len(h) != 64 || h == HashToken(strings.TrimPrefix(tok, TokenPrefix)) {
			t.Fatal("hash must cover the whole plaintext including the prefix")
		}
	}
}

func TestTokenShapeChecks(t *testing.T) {
	for _, bad := range []string{"", TokenPrefix, TokenPrefix + "short", "ffscim-" + strings.Repeat("a", 43), TokenPrefix + strings.Repeat("a", 44), TokenPrefix + strings.Repeat("+", 43)} {
		if WellFormedToken(bad) {
			t.Fatalf("%q accepted", bad)
		}
	}
	if ContainsToken("ffscim_ is the prefix") {
		t.Fatal("bare prefix is not a token")
	}
	if IsWorkspaceToken("an-env-token-of-at-least-32-characters") {
		t.Fatal("env token routed as workspace token")
	}
}
