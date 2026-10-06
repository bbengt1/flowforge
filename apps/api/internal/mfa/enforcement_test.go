package mfa

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func TestResolveEnforcement(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		raw        string
		appEnv     string
		requireTLS bool
		off        bool
		wantErr    bool
	}{
		{name: "unset", raw: "", appEnv: "development", off: false},
		{name: "on", raw: "on", appEnv: "development", off: false},
		{name: "on upper", raw: " ON ", appEnv: "local", off: false},
		{name: "off in development", raw: "off", appEnv: "development", off: true},
		{name: "off in dev", raw: "off", appEnv: "dev", off: true},
		{name: "off in local", raw: "off", appEnv: "local", off: true},
		{name: "off in test", raw: "OFF", appEnv: "test", off: true},
		{name: "off empty app env", raw: "off", appEnv: "", wantErr: true},
		{name: "off production", raw: "off", appEnv: "production", wantErr: true},
		{name: "off unknown app env", raw: "off", appEnv: "staging", wantErr: true},
		{name: "off require tls", raw: "off", appEnv: "development", requireTLS: true, wantErr: true},
		{name: "invalid", raw: "disabled", appEnv: "development", wantErr: true},
		{name: "false is not off", raw: "false", appEnv: "development", wantErr: true},
		{name: "zero is not off", raw: "0", appEnv: "development", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			off, err := ResolveEnforcement(tc.raw, tc.appEnv, tc.requireTLS)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected boot error")
				}
				if strings.Contains(err.Error(), tc.raw) && strings.TrimSpace(tc.raw) != "" && strings.ToLower(strings.TrimSpace(tc.raw)) != EnforcementOff {
					t.Fatalf("error echoed the value %q: %v", tc.raw, err)
				}
				if !strings.Contains(err.Error(), EnvEnforcement) {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if off != tc.off {
				t.Fatalf("off = %v want %v", off, tc.off)
			}
		})
	}
}

func TestResolveEnforcementProductionLockedMatchesAuthz(t *testing.T) {
	t.Parallel()
	for _, appEnv := range []string{"", "production", "staging", "qa"} {
		if !authz.ProductionLocked(appEnv, false) {
			t.Fatalf("%q should be production-locked", appEnv)
		}
		if _, err := ResolveEnforcement(EnforcementOff, appEnv, false); err == nil {
			t.Fatalf("%q + off must fail boot", appEnv)
		}
	}
	if _, err := ResolveEnforcement(EnforcementOff, "development", true); err == nil {
		t.Fatal("REQUIRE_TLS=true + off must fail boot")
	}
}

func TestWarnBypass(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	WarnBypass(nil)
	WarnBypass(log)
	out := buf.String()
	if !strings.Contains(out, `"level":"WARN"`) && !strings.Contains(out, `"level":"warn"`) {
		t.Fatalf("expected WARN: %s", out)
	}
	if !strings.Contains(out, "MFA_ENFORCEMENT=off") || !strings.Contains(out, "dev/QA only") {
		t.Fatalf("message = %s", out)
	}
	if strings.Contains(out, "secret") || strings.Contains(out, "password") || strings.Contains(out, "BEGIN ") {
		t.Fatalf("warn echoed secret-shaped text: %s", out)
	}
}

func TestDeployAndComposeDoNotMentionMFAEnforcement(t *testing.T) {
	t.Parallel()
	repo := filepath.Join("..", "..", "..", "..")
	deploy := filepath.Join(repo, "deploy")
	info, err := os.Stat(deploy)
	if err != nil || !info.IsDir() {
		t.Fatalf("deploy missing: %v", err)
	}
	hits := map[string]struct{}{}
	err = filepath.WalkDir(deploy, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		mentioned, err := fileMentionsMFAEnforcement(path, d.Name())
		if err != nil {
			return err
		}
		if mentioned {
			hits[path] = struct{}{}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(repo, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "vendor":
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !isComposeManifest(name) {
			return nil
		}
		mentioned, err := fileMentionsMFAEnforcement(path, name)
		if err != nil {
			return err
		}
		if mentioned {
			hits[path] = struct{}{}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) > 0 {
		paths := make([]string, 0, len(hits))
		for path := range hits {
			paths = append(paths, path)
		}
		t.Fatalf("deploy/ and compose manifests must not mention %s: %s", EnvEnforcement, strings.Join(paths, ", "))
	}
}

// isComposeManifest reports docker-compose*.y*ml and compose*.y*ml names
// anywhere in the tree (compose.yml, compose.yaml, and the same stems
// with a suffix before the extension).
func isComposeManifest(name string) bool {
	for _, pattern := range []string{
		"docker-compose*.yml",
		"docker-compose*.yaml",
		"compose*.yml",
		"compose*.yaml",
	} {
		ok, err := filepath.Match(pattern, name)
		if err == nil && ok {
			return true
		}
	}
	return false
}

func fileMentionsMFAEnforcement(path, name string) (bool, error) {
	if strings.Contains(name, EnvEnforcement) {
		return true, nil
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	return strings.Contains(string(body), EnvEnforcement), nil
}
