package artifact

import "testing"

func TestScanRejectsIrredactableSecrets(t *testing.T) {
	cases := [][]byte{
		[]byte("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"),
		[]byte("apiVersion: v1\nkind: Config\nusers:\n- name: a\n  user:\n    token: supersecret"),
		[]byte("apiVersion: v1\nkind: Secret\ndata:\n  token: YQ=="),
		[]byte("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG"),
	}
	for _, raw := range cases {
		res := Scan(KindFile, ClassInternal, raw)
		if res.Reject == "" {
			t.Fatalf("expected reject for %q", raw)
		}
	}
}

func TestScanRedactsTokenShapedLogs(t *testing.T) {
	res := Scan(KindLog, ClassInternal, []byte("ok\nAuthorization: Bearer abcdef.ghijk.lmnop\ndone"))
	if res.Reject != "" {
		t.Fatalf("reject = %q", res.Reject)
	}
	if !res.Redacted {
		t.Fatal("expected redacted")
	}
	if string(res.Safe) == "" || contains(string(res.Safe), "Bearer abcdef") {
		t.Fatalf("safe = %q", res.Safe)
	}
}

func TestScanRejectsSecretClassification(t *testing.T) {
	res := Scan(KindFile, "secret", []byte("hello world"))
	if res.Reject == "" {
		t.Fatal("expected reject")
	}
}

func TestSanitizeFilename(t *testing.T) {
	if got := SanitizeFilename("../../etc/passwd"); got != "passwd" {
		t.Fatalf("got %q", got)
	}
	if got := SanitizeFilename("ok.log"); got != "ok.log" {
		t.Fatalf("got %q", got)
	}
}

func TestBoundLines(t *testing.T) {
	text := "a\nb\nc\nd"
	lines, next, trunc := BoundLines(text, 1, 2, 1024)
	if len(lines) != 2 || lines[0] != "b" || next != 3 || !trunc {
		t.Fatalf("lines=%v next=%d trunc=%v", lines, next, trunc)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || (len(s) > 0 && (stringIndex(s, sub) >= 0)))
}

func stringIndex(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
