package ssh

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	cryptossh "golang.org/x/crypto/ssh"
)

func operatorPerms() []string {
	return authz.ExpandRoles([]string{authz.RoleOperator})
}

func profileSpec() map[string]any {
	return map[string]any{
		"parameterSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"unit": map[string]any{"type": "string", "minLength": 1, "maxLength": 64},
			},
			"required": []any{"unit"},
		},
		"template":  "systemctl restart {unit}",
		"retrySafe": false,
	}
}

func sensitiveProfileSpec() map[string]any {
	return map[string]any{
		"parameterSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"token": map[string]any{"type": "string", "sensitive": true, "minLength": 1, "maxLength": 64},
			},
			"required": []any{"token"},
		},
		"template": "echo {token}",
	}
}

func handleFor(server *FakeServer) *Handle {
	h := &Handle{
		ID:           "handle-1",
		SSHTargetID:  "22222222-2222-4222-8222-222222222222",
		CredentialID: "33333333-3333-4333-8333-333333333333",
		Username:     DefaultUsername,
		ExpiresAt:    time.Now().UTC().Add(time.Minute),
	}
	h.BindSigner(server.UserSigner)
	return h
}

func baseReq(server *FakeServer, params map[string]any) Request {
	return Request{
		SSHTargetID:      "22222222-2222-4222-8222-222222222222",
		CommandProfileID: "44444444-4444-4444-8444-444444444444",
		Parameters:       params,
		TimeoutSeconds:   5,
		RetryPolicy:      RetryPolicy{MaxAttempts: 0},
		Permissions:      operatorPerms(),
		Target: TargetContext{
			ID:               "22222222-2222-4222-8222-222222222222",
			Hostname:         "127.0.0.1",
			Port:             server.Port(),
			Username:         DefaultUsername,
			HostKeySHA256:    server.Fingerprint,
			AllowedAddresses: []string{"127.0.0.1"},
			AddressesPresent: true,
		},
		Profile:       ProfileContextFromSpec("44444444-4444-4444-8444-444444444444", profileSpec()),
		Handle:        handleFor(server),
		Resolver:      mapResolver{"127.0.0.1": []net.IP{net.ParseIP("127.0.0.1")}},
		CorrelationID: "corr-ssh-1",
		ActorID:       "actor-1",
		Transport:     LiveTransport{},
	}
}

type mapResolver map[string][]net.IP

func (m mapResolver) LookupIP(_ context.Context, _ string, host string) ([]net.IP, error) {
	if ips, ok := m[host]; ok {
		return ips, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func TestApprovedExecution(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	req := baseReq(server, map[string]any{"unit": "nginx"})
	res := Execute(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("approved: %+v", res.Error)
	}
	if res.Stdout != "ok" || res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("result = %+v", res)
	}
	if res.ConnectedAddress != net.JoinHostPort("127.0.0.1", strconv.Itoa(server.Port())) {
		t.Fatalf("connected = %s", res.ConnectedAddress)
	}
	if res.Retry.MaxAttempts != 0 || res.Retry.ExecutedAttempts != 1 {
		t.Fatalf("retry = %+v", res.Retry)
	}
	cmds := server.Commands()
	if len(cmds) != 1 || cmds[0] != "systemctl restart 'nginx'" {
		t.Fatalf("commands = %#v", cmds)
	}
	if !server.AcceptedPublicKey() {
		t.Fatal("expected publickey auth")
	}
	if res.Audit["correlationId"] != "corr-ssh-1" || res.Audit["outcome"] != "success" {
		t.Fatalf("audit = %+v", res.Audit)
	}
}

func TestDeniedForwardingAndAuthMethods(t *testing.T) {
	t.Run("password flag", func(t *testing.T) {
		_, err := IsolatedClientConfig(ConnectConfig{
			NetworkAddress: "127.0.0.1:22",
			Username:       DefaultUsername,
			Signer:         mustSigner(t),
			HostKeySHA256:  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			AllowPassword:  true,
		})
		if err == nil || err.Code != CodeAuthDenied {
			t.Fatalf("password: %+v", err)
		}
	})
	t.Run("forwarding flags", func(t *testing.T) {
		for _, cfg := range []ConnectConfig{
			{AgentForwarding: true},
			{PortForwarding: true},
			{ProxyCommand: true},
			{InteractiveShell: true},
		} {
			cfg.NetworkAddress = "127.0.0.1:22"
			cfg.Username = DefaultUsername
			cfg.Signer = mustSigner(t)
			cfg.HostKeySHA256 = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
			_, err := IsolatedClientConfig(cfg)
			if err == nil || err.Code != CodeForwardingDenied {
				t.Fatalf("forwarding %+v: %+v", cfg, err)
			}
		}
	})
	t.Run("hostname dial denied", func(t *testing.T) {
		_, err := IsolatedClientConfig(ConnectConfig{
			NetworkAddress: "bastion.example.com:22",
			Username:       DefaultUsername,
			Signer:         mustSigner(t),
			HostKeySHA256:  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		})
		if err == nil || err.Code != CodeAddressDenied {
			t.Fatalf("hostname dial: %+v", err)
		}
	})
	t.Run("live client does not offer password", func(t *testing.T) {
		server, err := StartFakeServer()
		if err != nil {
			t.Fatal(err)
		}
		defer server.Close()
		server.Password = "s3cret"
		req := baseReq(server, map[string]any{"unit": "nginx"})
		res := Execute(context.Background(), req)
		if !res.OK {
			t.Fatalf("run: %+v", res.Error)
		}
		if len(server.Passwords()) != 0 {
			t.Fatalf("client offered passwords: %#v", server.Passwords())
		}
		for _, typ := range append(server.ChannelTypes(), server.RequestTypes()...) {
			if strings.Contains(typ, "tcpip") || strings.Contains(typ, "agent") || typ == "shell" || typ == "pty-req" {
				t.Fatalf("unsafe request %s", typ)
			}
		}
	})
}

func TestKnownHostMismatch(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.Target.HostKeySHA256 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeHostKeyMismatch {
		t.Fatalf("mismatch: %+v", res.Error)
	}
	if len(server.Commands()) != 0 {
		t.Fatal("command ran after host-key mismatch")
	}
}

func TestAddressAllowlistAndDNSRebinding(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	t.Run("rebinding address denied", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
req.Target.Hostname = "bastion.example.com"
		req.Resolver = mapResolver{"bastion.example.com": []net.IP{net.ParseIP("203.0.113.9")}}
		req.Target.AllowedAddresses = []string{"127.0.0.1"}
		req.Target.AddressesPresent = true
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeAddressDenied {
			t.Fatalf("rebind: %+v", res.Error)
		}
		if len(server.Commands()) != 0 {
			t.Fatal("connected after rebinding deny")
		}
	})

	t.Run("any unallowlisted A record fails closed", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
req.Target.Hostname = "dual.example.com"
		req.Resolver = mapResolver{"dual.example.com": []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("198.51.100.20")}}
		req.Target.AllowedAddresses = []string{"127.0.0.1"}
		req.Target.AddressesPresent = true
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeAddressDenied {
			t.Fatalf("dual: %+v", res.Error)
		}
	})

	t.Run("dns name without allowlist denied", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
req.Target.Hostname = "open.example.com"
		req.Resolver = mapResolver{"open.example.com": []net.IP{net.ParseIP("127.0.0.1")}}
		req.Target.AllowedAddresses = nil
		req.Target.AddressesPresent = false
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeAddressDenied {
			t.Fatalf("open dns: %+v", res.Error)
		}
	})

	t.Run("connects only to verified address", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
req.Target.Hostname = "edge.example.com"
		req.Resolver = mapResolver{"edge.example.com": []net.IP{net.ParseIP("127.0.0.1")}}
		req.Target.AllowedAddresses = []string{"127.0.0.0/24"}
		res := Execute(context.Background(), req)
		if !res.OK {
			t.Fatalf("cidr: %+v", res.Error)
		}
		if res.ConnectedAddress != net.JoinHostPort("127.0.0.1", strconv.Itoa(server.Port())) {
			t.Fatalf("dialed hostname? %s", res.ConnectedAddress)
		}
	})
}

func TestTimeout(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.Delay = 2 * time.Second
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.TimeoutSeconds = 1
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeTimeout {
		t.Fatalf("timeout: %+v", res.Error)
	}
}

func TestTimeoutErrorClassification(t *testing.T) {
	t.Parallel()
	cases := []error{
		context.DeadlineExceeded,
		os.ErrDeadlineExceeded,
		&net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded},
	}
	for _, err := range cases {
		got := asEngineError(err, CodeCommandFailed)
		if got == nil || got.Code != CodeTimeout {
			t.Fatalf("asEngineError(%v) = %+v, want timeout", err, got)
		}
	}
	canceled := asEngineError(context.Canceled, CodeCommandFailed)
	if canceled == nil || canceled.Code != CodeCanceled {
		t.Fatalf("canceled: %+v", canceled)
	}
}

func TestCredentialRedaction(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.Stdout = "-----BEGIN OPENSSH PRIVATE KEY-----\nleaked\n-----END OPENSSH PRIVATE KEY-----"
	req := baseReq(server, map[string]any{"unit": "nginx"})
	req.Profile = ProfileContextFromSpec("p", sensitiveProfileSpec())
	req.Parameters = map[string]any{"token": "super-secret-value"}
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("run: %+v", res.Error)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, leak := range []string{"super-secret-value", "BEGIN OPENSSH", "privateKey", "leaked"} {
		if strings.Contains(body, leak) {
			t.Fatalf("%s leaked: %s", leak, body)
		}
	}
	if res.Parameters["token"] != "[redacted]" {
		t.Fatalf("params = %+v", res.Parameters)
	}
	hraw, err := json.Marshal(req.Handle)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(hraw), "signer") || strings.Contains(string(hraw), "BEGIN") {
		t.Fatalf("handle leaked: %s", hraw)
	}
}

func TestAdversarialParameterInjection(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	req := baseReq(server, map[string]any{"unit": "api; rm -rf /"})
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("quoted injection: %+v", res.Error)
	}
	if got := server.Commands(); len(got) != 1 || got[0] != "systemctl restart 'api; rm -rf /'" {
		t.Fatalf("command = %#v", server.Commands())
	}

	req = baseReq(server, map[string]any{"unit": "nginx", "extra": "$(whoami)"})
	res = Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeParameterRejected {
		t.Fatalf("extra param: %+v", res.Error)
	}

	req = baseReq(server, map[string]any{"unit": "nginx"})
	req.Profile.Spec = map[string]any{
		"parameterSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		"template":        "echo $(whoami)",
	}
	res = Execute(context.Background(), req)
	if res.OK || res.Error == nil {
		t.Fatal("interpolation template must fail")
	}
}

func TestAuthzPolicyRetryAndLeaseStub(t *testing.T) {
	server, err := StartFakeServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	t.Run("missing permission", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
		req.Permissions = authz.ExpandRoles([]string{authz.RoleViewer})
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodePermissionDenied {
			t.Fatalf("perm: %+v", res.Error)
		}
	})

	t.Run("root denied", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
		req.Target.Username = "root"
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeRootDenied {
			t.Fatalf("root: %+v", res.Error)
		}
	})

	t.Run("policy deny before connect", func(t *testing.T) {
		server.ResetRecords()
		req := baseReq(server, map[string]any{"unit": "nginx"})
		req.Policy = PolicyContext{Deny: true}
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodePolicyDenied {
			t.Fatalf("deny: %+v", res.Error)
		}
		if len(server.Commands()) != 0 {
			t.Fatal("connected after policy deny")
		}
	})

	t.Run("retry without retrySafe", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
		req.RetryPolicy.MaxAttempts = 2
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeRetryDenied {
			t.Fatalf("retry: %+v", res.Error)
		}
	})

	t.Run("retrySafe records policy but does not re-run", func(t *testing.T) {
		server.ResetRecords()
		req := baseReq(server, map[string]any{"unit": "nginx"})
		req.Profile.RetrySafe = true
		req.Profile.Spec["retrySafe"] = true
		req.RetryPolicy.MaxAttempts = 2
		res := Execute(context.Background(), req)
		if !res.OK {
			t.Fatalf("retrySafe: %+v", res.Error)
		}
		if res.Retry.MaxAttempts != 2 || res.Retry.ExecutedAttempts != 1 || res.Retry.Semantics != "E8.3" {
			t.Fatalf("retry state = %+v", res.Retry)
		}
		if len(server.Commands()) != 1 {
			t.Fatalf("blind re-run: %#v", server.Commands())
		}
	})

	t.Run("lease loss is indeterminate", func(t *testing.T) {
		server.ResetRecords()
		req := baseReq(server, map[string]any{"unit": "nginx"})
		req.LeaseLost = true
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeIndeterminate {
			t.Fatalf("lease: %+v", res.Error)
		}
		if len(server.Commands()) != 0 {
			t.Fatal("retried after lease loss")
		}
	})

	t.Run("missing handle", func(t *testing.T) {
		req := baseReq(server, map[string]any{"unit": "nginx"})
		req.Handle = nil
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeHandleForbidden {
			t.Fatalf("handle: %+v", res.Error)
		}
	})
}

func TestHandleFromVaultJSONNeverExportsKey(t *testing.T) {
	signer := mustSigner(t)
	_ = signer
	_, _, err := ExtractPrivateKey([]byte(`{"privateKey":"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----","passphrase":"pw"}`))
	if err != nil {
		t.Fatal(err)
	}
	h := Handle{ID: "h", SSHTargetID: "t", ExpiresAt: time.Now().UTC().Add(time.Minute)}
	raw, _ := json.Marshal(h)
	if strings.Contains(string(raw), "privateKey") || strings.Contains(string(raw), "passphrase") {
		t.Fatalf("exported: %s", raw)
	}
}

func TestCatalogIsolationAndRetryDefaults(t *testing.T) {
	cat := Catalog()
	if cat.Retry.DefaultMaxAttempts != 0 || cat.Isolation.PasswordAuth || cat.Isolation.InteractiveShell {
		t.Fatalf("catalog = %+v", cat)
	}
	if !cat.Isolation.ConnectVerifiedAddress || !cat.Isolation.EphemeralCredentialHandle {
		t.Fatalf("isolation = %+v", cat.Isolation)
	}
	found := map[string]bool{}
	for _, e := range cat.Errors {
		found[e.Code] = true
	}
	for _, code := range []string{CodeHostKeyMismatch, CodeAddressDenied, CodeTimeout, CodeAuthDenied, CodeForwardingDenied} {
		if !found[code] {
			t.Fatalf("missing error %s", code)
		}
	}
}

func mustSigner(t *testing.T) cryptossh.Signer {
	t.Helper()
	s, err := generateSigner()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

