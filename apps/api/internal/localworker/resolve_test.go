package localworker

import "testing"

func TestResolveLocalWorkerGate(t *testing.T) {
	cases := []struct {
		name       string
		flag       string
		appEnv     string
		requireTLS bool
		want       bool
		wantErr    bool
	}{
		{name: "empty production", want: false},
		{name: "production unset flag", appEnv: "production", want: false},
		{name: "unknown env", appEnv: "staging", want: false},
		{name: "development default on", appEnv: "development", want: true},
		{name: "dev default on", appEnv: "dev", want: true},
		{name: "local default on", appEnv: "local", want: true},
		{name: "test default on", appEnv: "test", want: true},
		{name: "development explicit on", flag: "1", appEnv: "development", want: true},
		{name: "development opt out", flag: "0", appEnv: "development", want: false},
		{name: "development false", flag: "false", appEnv: "development", want: false},
		{name: "development with tls", appEnv: "development", requireTLS: true, want: false},
		{name: "explicit on production", flag: "1", appEnv: "production", wantErr: true},
		{name: "explicit on empty env", flag: "true", appEnv: "", wantErr: true},
		{name: "explicit on with tls", flag: "1", appEnv: "development", requireTLS: true, wantErr: true},
		{name: "explicit off production", flag: "0", appEnv: "production", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Resolve(tc.flag, tc.appEnv, tc.requireTLS)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got enabled=%v", got)
				}
				if got {
					t.Fatal("error path must not enable worker")
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
