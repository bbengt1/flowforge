package runner

import "testing"

func TestResolveProductionLocked(t *testing.T) {
	cases := []struct {
		name       string
		flag       string
		appEnv     string
		requireTLS bool
		enabled    bool
		wantErr    bool
	}{
		{name: "development", flag: "1", appEnv: "development", wantErr: true},
		{name: "local explicit", flag: "1", appEnv: "local", wantErr: true},
		{name: "test", appEnv: "test", wantErr: true},
		{name: "empty env", appEnv: "", enabled: true},
		{name: "production", appEnv: "production", enabled: true},
		{name: "require tls overrides development", appEnv: "development", requireTLS: true, enabled: true},
		{name: "opt out while locked", flag: "0", appEnv: "production", enabled: false},
		{name: "opt out false", flag: "false", appEnv: "", enabled: false},
		{name: "dev flag still refused", flag: "1", appEnv: "development", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Resolve(tc.flag, tc.appEnv, tc.requireTLS)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected refusal")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.enabled {
				t.Fatalf("enabled = %v, want %v", got, tc.enabled)
			}
		})
	}
}
