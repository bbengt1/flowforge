package authz

import "testing"

func TestResolveTrustedDevIdentityHeadersFailClosed(t *testing.T) {
	cases := []struct {
		name       string
		flag       string
		appEnv     string
		requireTLS bool
		want       bool
		wantErr    bool
	}{
		{name: "empty config", want: false},
		{name: "flag off production", flag: "0", appEnv: "production", want: false},
		{name: "flag unset empty env", flag: "", appEnv: "", want: false},
		{name: "flag on empty env", flag: "1", appEnv: "", wantErr: true},
		{name: "flag on production", flag: "true", appEnv: "production", wantErr: true},
		{name: "flag on prod", flag: "yes", appEnv: "prod", wantErr: true},
		{name: "flag on unknown env", flag: "1", appEnv: "staging", wantErr: true},
		{name: "flag on development with tls", flag: "1", appEnv: "development", requireTLS: true, wantErr: true},
		{name: "flag on development", flag: "1", appEnv: "development", want: true},
		{name: "flag on local", flag: "on", appEnv: "local", want: true},
		{name: "flag on test", flag: "true", appEnv: "test", want: true},
		{name: "flag on DEV case", flag: "1", appEnv: "DEV", want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveTrustedDevIdentityHeaders(tc.flag, tc.appEnv, tc.requireTLS)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got enabled=%v", got)
				}
				if got {
					t.Fatal("error path must not enable trusted-dev")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("enabled = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestNonProductionAppEnv(t *testing.T) {
	if NonProductionAppEnv("") || NonProductionAppEnv("production") || NonProductionAppEnv("staging") {
		t.Fatal("empty/production/unknown must be production-locked")
	}
	if !NonProductionAppEnv("development") || !NonProductionAppEnv("test") {
		t.Fatal("explicit local/dev/test must be allowed")
	}
}

func TestProductionLocked(t *testing.T) {
	if !ProductionLocked("", false) || !ProductionLocked("production", false) || !ProductionLocked("staging", false) {
		t.Fatal("empty/production/unknown must be production-locked")
	}
	if ProductionLocked("development", false) || ProductionLocked("test", false) {
		t.Fatal("explicit local/dev/test without TLS must not be locked")
	}
	if !ProductionLocked("development", true) || !ProductionLocked("local", true) {
		t.Fatal("REQUIRE_TLS locks even non-production APP_ENV")
	}

	t.Setenv(EnvAppEnv, "")
	t.Setenv(EnvFlowforgeEnv, "")
	t.Setenv(EnvRequireTLS, "")
	if !ProductionLockedFromEnv() {
		t.Fatal("empty env is production-locked")
	}
	t.Setenv(EnvAppEnv, "development")
	if ProductionLockedFromEnv() {
		t.Fatal("APP_ENV=development must not be locked")
	}
	t.Setenv(EnvRequireTLS, "true")
	if !ProductionLockedFromEnv() {
		t.Fatal("REQUIRE_TLS locks development")
	}
}
