package buildinfo

import "testing"

func TestResolveDefaults(t *testing.T) {
	t.Setenv(EnvVersion, "")
	t.Setenv(EnvSHA, "")
	info := Resolve()
	if info.Version != DefaultVersion {
		t.Fatalf("version = %q, want %q", info.Version, DefaultVersion)
	}
	if info.SHA != DefaultSHA {
		t.Fatalf("sha = %q, want %q", info.SHA, DefaultSHA)
	}
}

func TestResolvePrefersSafeEnv(t *testing.T) {
	t.Setenv(EnvVersion, "1.2.3-rc.1")
	t.Setenv(EnvSHA, "ABCDEF0123456789")
	info := Resolve()
	if info.Version != "1.2.3-rc.1" {
		t.Fatalf("version = %q", info.Version)
	}
	if info.SHA != "abcdef0123456789" {
		t.Fatalf("sha = %q", info.SHA)
	}
}

func TestResolveRejectsSecretShapedValues(t *testing.T) {
	t.Setenv(EnvVersion, "-----BEGIN PRIVATE KEY-----")
	t.Setenv(EnvSHA, "super-secret-password-value")
	info := Resolve()
	if info.Version != DefaultVersion {
		t.Fatalf("unsafe version leaked: %q", info.Version)
	}
	if info.SHA != DefaultSHA {
		t.Fatalf("unsafe sha leaked: %q", info.SHA)
	}
}

func TestResolveRejectsWhitespaceAndOverlong(t *testing.T) {
	t.Setenv(EnvVersion, "good version")
	t.Setenv(EnvSHA, "abcdef0123456789abcdef0123456789abcdef0123456789")
	info := Resolve()
	if info.Version != DefaultVersion {
		t.Fatalf("spaced version accepted: %q", info.Version)
	}
	if info.SHA != DefaultSHA {
		t.Fatalf("overlong sha accepted: %q", info.SHA)
	}
}

func TestSanitizeAcceptsUnknownAndDev(t *testing.T) {
	if got := sanitizeVersion("DEV"); got != "dev" {
		t.Fatalf("sanitizeVersion(DEV) = %q", got)
	}
	if got := sanitizeSHA("UNKNOWN"); got != "unknown" {
		t.Fatalf("sanitizeSHA(UNKNOWN) = %q", got)
	}
}
