package httpnotify

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func operatorPerms() []string {
	return authz.ExpandRoles([]string{authz.RoleOperator})
}

type mapResolver map[string][]net.IP

func (m mapResolver) LookupIP(_ context.Context, _ string, host string) ([]net.IP, error) {
	if ips, ok := m[host]; ok {
		return ips, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func httpConn(hosts []string, addrs []string, methods []string, prefixes []string) ConnectionContext {
	if len(methods) == 0 {
		methods = []string{"GET", "POST"}
	}
	if len(prefixes) == 0 {
		prefixes = []string{"/"}
	}
	return ConnectionContext{
		ID:          "77777777-7777-4777-8777-777777777777",
		WorkspaceID: "ws-1",
		Type:        ConnectionHTTP,
		Published:   true,
		Policy: EndpointPolicy{
			Hosts:                    hosts,
			Methods:                  methods,
			PathPrefixes:             prefixes,
			Ports:                    []int{80, 443},
			TLSRequired:              false,
			AllowedAddresses:         addrs,
			AddressesPresent:         len(addrs) > 0,
			AllowPrivateDestinations: true, // httptest binds loopback; ADV-010 default-deny is tested separately
			MaxRequestBytes:          DefaultMaxRequestBytes,
			MaxResponseBytes:         DefaultMaxResponseBytes,
		},
	}
}

func baseHTTPReq(conn ConnectionContext, method, path string, payload map[string]any) Request {
	host := ""
	if len(conn.Policy.Hosts) > 0 {
		host = conn.Policy.Hosts[0]
	}
	return Request{
		Operation:      NodeHTTPRequest,
		ConnectionID:   conn.ID,
		WorkspaceID:    "ws-1",
		Method:         method,
		Path:           path,
		Host:           host,
		TimeoutSeconds: 5,
		Payload:        payload,
		Permissions:    operatorPerms(),
		Connection:     conn,
		Resolver:       mapResolver{host: []net.IP{net.ParseIP("127.0.0.1")}},
		CorrelationID:  "corr-http-1",
		ActorID:        "actor-1",
	}
}

func startHTTP(t *testing.T, handler http.HandlerFunc) (*httptest.Server, string, int) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	u := strings.TrimPrefix(srv.URL, "http://")
	_, port, err := net.SplitHostPort(u)
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	return srv, port, p
}

func TestApprovedHTTPRequest(t *testing.T) {
	var sawAuth string
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/v1/status" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"env":"staging"}`))
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, nil, []string{"/v1/"})
	conn.Policy.Ports = []int{port}
	req := baseHTTPReq(conn, http.MethodGet, "/v1/status", nil)
	req.Handle = &Handle{Authorization: "Bearer super-secret-token"}
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("approved: %+v", res.Error)
	}
	if res.StatusCode != 200 || res.Body["ok"] != true {
		t.Fatalf("result = %+v", res)
	}
	if sawAuth != "Bearer super-secret-token" {
		t.Fatalf("worker must send handle auth, got %q", sawAuth)
	}
	raw, _ := jsonish(res)
	if strings.Contains(raw, "super-secret-token") || strings.Contains(raw, "Bearer ") && strings.Contains(raw, "super-secret") {
		t.Fatalf("secret leaked: %s", raw)
	}
	if res.Audit["outcome"] != "success" || res.Audit["correlationId"] != "corr-http-1" {
		t.Fatalf("audit = %+v", res.Audit)
	}
}

func jsonish(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

func TestSSRFDenied(t *testing.T) {
	conn := httpConn([]string{"169.254.169.254"}, []string{"169.254.169.254"}, nil, nil)
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Resolver = mapResolver{"169.254.169.254": []net.IP{net.ParseIP("169.254.169.254")}}
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSSRFDenied {
		t.Fatalf("ssrf: %+v", res.Error)
	}
}

func TestDNSRebindingDenied(t *testing.T) {
	conn := httpConn([]string{"status.example.com"}, []string{"8.8.8.8"}, nil, nil)
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Resolver = mapResolver{"status.example.com": []net.IP{
		net.ParseIP("8.8.8.8"),
		net.ParseIP("169.254.169.254"),
	}}
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || (res.Error.Code != CodeSSRFDenied && res.Error.Code != CodeAddressDenied) {
		t.Fatalf("rebinding: %+v", res.Error)
	}
}

func TestRedirectDenied(t *testing.T) {
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", http.StatusFound)
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, []string{"GET"}, []string{"/"})
	conn.Policy.Ports = []int{port}
	conn.Policy.AllowRedirects = false
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || (res.Error.Code != CodeRedirectDenied && res.Error.Code != CodeSSRFDenied) {
		t.Fatalf("redirect: %+v", res.Error)
	}
}

func TestRedirectHopRevalidated(t *testing.T) {
	var hops []string
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		hops = append(hops, r.URL.Path)
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/admin", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, []string{"GET"}, []string{"/"})
	conn.Policy.Ports = []int{port}
	conn.Policy.AllowRedirects = true
	conn.Policy.MaxRedirects = 2
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("allowed redirect: %+v", res.Error)
	}
	if len(hops) < 2 {
		t.Fatalf("hops = %#v", hops)
	}

	// Redirect to a different host that is not allowlisted.
	srv2, _, port2 := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://evil.example.com/steal", http.StatusFound)
	})
	conn.Policy.Ports = []int{port2}
	conn.Policy.AllowRedirects = true
	conn.Policy.MaxRedirects = 2
	req = baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Transport = srv2.Client().Transport
	req.Resolver = mapResolver{
		"127.0.0.1":        []net.IP{net.ParseIP("127.0.0.1")},
		"evil.example.com": []net.IP{net.ParseIP("8.8.8.8")},
	}
	res = Execute(context.Background(), req)
	if res.OK || res.Error == nil || (res.Error.Code != CodeRedirectDenied && res.Error.Code != CodeInvalidEndpoint && res.Error.Code != CodeAddressDenied) {
		t.Fatalf("cross-host redirect: %+v", res.Error)
	}
}

func TestOversizeDenied(t *testing.T) {
	big := strings.Repeat("a", DefaultMaxResponseBytes+8)
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"data":"`+big+`"}`)
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, nil, nil)
	conn.Policy.Ports = []int{port}
	conn.Policy.MaxResponseBytes = 64
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeOversize {
		t.Fatalf("oversize: %+v", res.Error)
	}
}

func TestSecretRedaction(t *testing.T) {
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true,"token":"abc-secret","authorization":"Bearer xyz"}`))
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, []string{"POST"}, []string{"/"})
	conn.Policy.Ports = []int{port}
	conn.Policy.SecretFields = []string{"token"}
	req := baseHTTPReq(conn, http.MethodPost, "/", map[string]any{"token": "abc-secret", "name": "ops"})
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("secret field authorized: %+v", res.Error)
	}
	if res.Body["token"] != redactedMarker || res.Body["authorization"] != redactedMarker {
		t.Fatalf("body not redacted: %+v", res.Body)
	}

	conn.Policy.SecretFields = nil
	req = baseHTTPReq(conn, http.MethodPost, "/", map[string]any{"token": "abc-secret"})
	req.Transport = srv.Client().Transport
	res = Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSecretDenied {
		t.Fatalf("unauthorized secret: %+v", res.Error)
	}
}

func TestWrongConnectionType(t *testing.T) {
	conn := httpConn([]string{"mail.example.com"}, []string{"127.0.0.1"}, nil, nil)
	conn.Type = ConnectionSMTP
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeWrongConnectionType {
		t.Fatalf("wrong type: %+v", res.Error)
	}
}

func TestUnpublishedPin(t *testing.T) {
	conn := httpConn([]string{"status.example.com"}, []string{"127.0.0.1"}, nil, nil)
	conn.Published = false
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeUnpublishedPin {
		t.Fatalf("unpublished: %+v", res.Error)
	}
}

func TestTenancyDenied(t *testing.T) {
	conn := httpConn([]string{"status.example.com"}, []string{"127.0.0.1"}, nil, nil)
	conn.WorkspaceID = "ws-other"
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeTenancyDenied {
		t.Fatalf("tenancy: %+v", res.Error)
	}
}

func TestWebhookIdempotencyHeader(t *testing.T) {
	var key string
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		key = r.Header.Get(IdempotencyHeader)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"delivered":true}`))
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, []string{"POST"}, []string{"/"})
	conn.Type = ConnectionWebhook
	conn.Policy.Ports = []int{port}
	req := baseHTTPReq(conn, http.MethodPost, "/", map[string]any{"event": "deployed"})
	req.Operation = NodeWebhook
	req.IdempotencyKey = "idem-1"
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("webhook: %+v", res.Error)
	}
	if key != "idem-1" {
		t.Fatalf("idempotency = %q", key)
	}
}

func TestEmailApprovedAndRecipientDeny(t *testing.T) {
	mailer := &CaptureMailer{}
	req := EmailRequest{
		ConnectionID:  "99999999-9999-4999-8999-999999999999",
		WorkspaceID:   "ws-1",
		Payload:       map[string]any{"service": "api"},
		Permissions:   operatorPerms(),
		Connection:    ConnectionContext{ID: "c1", WorkspaceID: "ws-1", Type: ConnectionSMTP, Published: true},
		Recipients:    RecipientListContext{ID: "r1", WorkspaceID: "ws-1", Published: true, Emails: []string{"ops@example.com"}, Domains: []string{"example.com"}},
		Template:      TemplateContext{ID: "t1", WorkspaceID: "ws-1", Published: true, Subject: "Alert", Body: "Service {service} is degraded.", InputSchema: map[string]any{"type": "object", "required": []any{"service"}, "properties": map[string]any{"service": map[string]any{"type": "string"}}}},
		Mailer:        mailer,
		CorrelationID: "corr-mail-1",
	}
	res := ExecuteEmail(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("email: %+v", res.Error)
	}
	if len(mailer.Messages) != 1 || mailer.Messages[0].To[0] != "ops@example.com" {
		t.Fatalf("mail = %+v", mailer.Messages)
	}
	if !strings.Contains(mailer.Messages[0].Body, "api") {
		t.Fatalf("body = %s", mailer.Messages[0].Body)
	}

	req.Payload = map[string]any{"to": "evil@other.com", "service": "api"}
	res = ExecuteEmail(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeRecipientDenied {
		t.Fatalf("payload to: %+v", res.Error)
	}

	req.Payload = map[string]any{"recipient": "evil@other.com", "service": "api"}
	req.Template.InputSchema = map[string]any{
		"type": "object",
		"properties": map[string]any{
			"service":   map[string]any{"type": "string"},
			"recipient": map[string]any{"type": "string"},
		},
	}
	res = ExecuteEmail(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeRecipientDenied {
		t.Fatalf("schema recipient deny: %+v", res.Error)
	}

	req.Connection.Type = ConnectionHTTP
	req.Payload = map[string]any{"service": "api"}
	res = ExecuteEmail(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeWrongConnectionType {
		t.Fatalf("smtp type: %+v", res.Error)
	}
}

func TestCatalogDocumentsGateAndNodes(t *testing.T) {
	cat := Catalog()
	if !cat.Gate.Enabled || len(cat.Gate.Suites) < 8 {
		t.Fatalf("gate = %+v", cat.Gate)
	}
	if len(cat.Nodes) != 3 {
		t.Fatalf("nodes = %+v", cat.Nodes)
	}
	for _, n := range cat.Nodes {
		if !n.Enabled || len(n.AllowedWith) == 0 || len(n.Permissions) == 0 {
			t.Fatalf("node = %+v", n)
		}
	}
	if !cat.Isolation.PrivateAndLoopbackDeniedByDefault || !cat.Isolation.SSRFDenied {
		t.Fatalf("isolation = %+v", cat.Isolation)
	}
	if len(cat.Isolation.AllowPrivateDestinationsOptIn) == 0 {
		t.Fatal("catalog must document allowPrivateDestinations opt-in")
	}
	off := CatalogWithEnabled(false)
	if off.Gate.Enabled {
		t.Fatalf("kill switch gate still enabled: %+v", off.Gate)
	}
	for _, n := range off.Nodes {
		if n.Enabled {
			t.Fatalf("kill switch left node enabled: %+v", n)
		}
	}
}

func TestPrivateAndLoopbackDeniedByDefault(t *testing.T) {
	cases := []struct {
		name string
		host string
		ip   string
	}{
		{name: "localhost", host: "localhost", ip: "127.0.0.1"},
		{name: "loopback-v4", host: "127.0.0.1", ip: "127.0.0.1"},
		{name: "loopback-v6", host: "::1", ip: "::1"},
		{name: "rfc1918-10", host: "10.0.0.1", ip: "10.0.0.1"},
		{name: "rfc1918-172", host: "172.16.0.1", ip: "172.16.0.1"},
		{name: "rfc1918-192", host: "192.168.1.10", ip: "192.168.1.10"},
		{name: "link-local", host: "169.254.1.1", ip: "169.254.1.1"},
		{name: "metadata", host: "169.254.169.254", ip: "169.254.169.254"},
		{name: "ula", host: "fd12:3456:789a::1", ip: "fd12:3456:789a::1"},
		{name: "cgnat", host: "100.64.0.1", ip: "100.64.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conn := httpConn([]string{tc.host}, []string{tc.ip}, nil, nil)
			conn.Policy.AllowPrivateDestinations = false
			req := baseHTTPReq(conn, http.MethodGet, "/", nil)
			req.Resolver = mapResolver{tc.host: []net.IP{net.ParseIP(tc.ip)}}
			res := Execute(context.Background(), req)
			if res.OK || res.Error == nil || res.Error.Code != CodeSSRFDenied {
				t.Fatalf("default deny %s: %+v", tc.name, res.Error)
			}
			if strings.Contains(res.Error.Message, tc.ip) {
				t.Fatalf("denied problem leaked address %s: %s", tc.ip, res.Error.Message)
			}
			raw, _ := jsonish(res)
			if strings.Contains(raw, tc.ip) && tc.ip != tc.host {
				t.Fatalf("result leaked resolved address %s: %s", tc.ip, raw)
			}
		})
	}
}

type stubTripper struct {
	status int
	body   string
}

func (s stubTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	status := s.status
	if status == 0 {
		status = http.StatusOK
	}
	body := s.body
	if body == "" {
		body = `{"ok":true}`
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

func TestPublicHTTPSAllowed(t *testing.T) {
	conn := httpConn([]string{"status.example.com"}, []string{"8.8.8.8"}, []string{"GET"}, []string{"/"})
	conn.Policy.AllowPrivateDestinations = false
	conn.Policy.TLSRequired = true
	conn.Policy.Ports = []int{443}
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Resolver = mapResolver{"status.example.com": []net.IP{net.ParseIP("8.8.8.8")}}
	req.Transport = stubTripper{}
	res := Execute(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("public destination: %+v", res.Error)
	}
}

func TestAllowPrivateDestinationsOptIn(t *testing.T) {
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, []string{"GET"}, []string{"/"})
	conn.Policy.Ports = []int{port}
	conn.Policy.AllowPrivateDestinations = true
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("connection opt-in: %+v", res.Error)
	}

	conn.Policy.AllowPrivateDestinations = false
	req = baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Policy.Kind = "http"
	req.Policy.AllowPrivateDestinations = true
	req.Transport = srv.Client().Transport
	res = Execute(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("workspace policy opt-in: %+v", res.Error)
	}

	conn.Policy.AllowPrivateDestinations = false
	req = baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Policy.AllowPrivateDestinations = false
	req.Transport = srv.Client().Transport
	res = Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSSRFDenied {
		t.Fatalf("unset opt-in must fail closed: %+v", res.Error)
	}
}

func TestMetadataStillDeniedWhenPrivateAllowed(t *testing.T) {
	conn := httpConn([]string{"169.254.169.254"}, []string{"169.254.169.254"}, nil, nil)
	conn.Policy.AllowPrivateDestinations = true
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Resolver = mapResolver{"169.254.169.254": []net.IP{net.ParseIP("169.254.169.254")}}
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSSRFDenied {
		t.Fatalf("metadata must stay denied: %+v", res.Error)
	}

	conn = httpConn([]string{"fd00:ec2::254"}, []string{"fd00:ec2::254"}, nil, nil)
	conn.Policy.AllowPrivateDestinations = true
	req = baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Resolver = mapResolver{"fd00:ec2::254": []net.IP{net.ParseIP("fd00:ec2::254")}}
	res = Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSSRFDenied {
		t.Fatalf("IPv6 IMDS must stay denied: %+v", res.Error)
	}
	if strings.Contains(res.Error.Message, "fd00:ec2::254") {
		t.Fatalf("IPv6 IMDS problem leaked address: %s", res.Error.Message)
	}
}

func TestApprovalPolicyCannotOptInPrivate(t *testing.T) {
	conn := httpConn([]string{"10.0.0.8"}, []string{"10.0.0.8"}, nil, nil)
	conn.Policy.AllowPrivateDestinations = false
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Policy.Kind = "approval"
	req.Policy.AllowPrivateDestinations = true
	req.Resolver = mapResolver{"10.0.0.8": []net.IP{net.ParseIP("10.0.0.8")}}
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSSRFDenied {
		t.Fatalf("approval policy must not opt in private destinations: %+v", res.Error)
	}
}

func TestDNSRebindingToPrivateDenied(t *testing.T) {
	conn := httpConn([]string{"status.example.com"}, []string{"8.8.8.8", "10.0.0.1"}, nil, nil)
	conn.Policy.AllowPrivateDestinations = false
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Resolver = mapResolver{"status.example.com": []net.IP{
		net.ParseIP("8.8.8.8"),
		net.ParseIP("10.0.0.1"),
	}}
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSSRFDenied {
		t.Fatalf("rebinding to private: %+v", res.Error)
	}
	if strings.Contains(res.Error.Message, "10.0.0.1") {
		t.Fatalf("rebinding problem leaked address: %s", res.Error.Message)
	}
}

type redirectTripper struct {
	location string
}

func (r redirectTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusFound,
		Header:     http.Header{"Location": []string{r.location}},
		Body:       io.NopCloser(strings.NewReader("")),
		Request:    req,
	}, nil
}

func TestRedirectToPrivateDenied(t *testing.T) {
	conn := httpConn([]string{"status.example.com", "internal.example.com"}, []string{"8.8.8.8"}, []string{"GET"}, []string{"/"})
	conn.Policy.Ports = []int{443, 80}
	conn.Policy.TLSRequired = false
	conn.Policy.AllowRedirects = true
	conn.Policy.MaxRedirects = 2
	conn.Policy.AllowPrivateDestinations = false
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Host = "status.example.com"
	req.Resolver = mapResolver{
		"status.example.com":   []net.IP{net.ParseIP("8.8.8.8")},
		"internal.example.com": []net.IP{net.ParseIP("10.1.2.3")},
	}
	req.Transport = redirectTripper{location: "http://internal.example.com/internal"}
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || (res.Error.Code != CodeSSRFDenied && res.Error.Code != CodeRedirectDenied) {
		t.Fatalf("redirect to private: %+v", res.Error)
	}
	if res.Error != nil && strings.Contains(res.Error.Message, "10.1.2.3") {
		t.Fatalf("redirect problem leaked address: %s", res.Error.Message)
	}
}

func TestSchemaRejectsWrongTypesAndExtraFields(t *testing.T) {
	schema := map[string]any{
		"type":                 "object",
		"required":             []any{"count"},
		"additionalProperties": false,
		"properties": map[string]any{
			"count": map[string]any{"type": "integer", "minimum": 1, "maximum": 10},
			"env":   map[string]any{"type": "string", "enum": []any{"staging", "prod"}},
		},
	}
	if SchemaAllows(schema, map[string]any{"count": "wrong"}) {
		t.Fatal("string must not satisfy integer")
	}
	if SchemaAllows(schema, map[string]any{"count": 3, "extra": true}) {
		t.Fatal("additionalProperties false must deny extras")
	}
	if SchemaAllows(schema, map[string]any{"count": 3, "env": "dev"}) {
		t.Fatal("enum must deny unknown values")
	}
	if !SchemaAllows(schema, map[string]any{"count": 3.0, "env": "staging"}) {
		t.Fatal("whole JSON numbers and enum members must pass")
	}
	if SchemaAllows(map[string]any{"type": "integre"}, map[string]any{"count": 1}) {
		t.Fatal("unsupported schema types must fail closed")
	}

	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"count":"wrong"}`))
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, nil, nil)
	conn.Policy.Ports = []int{port}
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.ResponseSchema = schema
	req.SchemaPublished = true
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeSchemaRejected {
		t.Fatalf("typed schema: %+v", res.Error)
	}
}

func TestSecretValueEchoedUnderInnocentKey(t *testing.T) {
	srv, _, port := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true,"echo":"opaque-value-secret"}`))
	})
	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, []string{"POST"}, []string{"/"})
	conn.Policy.Ports = []int{port}
	conn.Policy.SecretFields = []string{"apiKey"}
	req := baseHTTPReq(conn, http.MethodPost, "/", map[string]any{"apiKey": "opaque-value-secret", "name": "ops"})
	req.Handle = &Handle{Authorization: "Bearer handle-token-value"}
	req.Transport = srv.Client().Transport
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("echo: %+v", res.Error)
	}
	if res.Body["echo"] != redactedMarker {
		t.Fatalf("echoed secret not redacted: %+v", res.Body)
	}
	raw, _ := jsonish(res)
	if strings.Contains(raw, "opaque-value-secret") || strings.Contains(raw, "handle-token-value") {
		t.Fatalf("secret leaked: %s", raw)
	}

	srv2, _, port2 := startHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"echo":"123"}`))
	})
	conn.Policy.Ports = []int{port2}
	conn.Policy.SecretFields = []string{"pin"}
	req = baseHTTPReq(conn, http.MethodPost, "/", map[string]any{"pin": "123"})
	req.Transport = srv2.Client().Transport
	res = Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("short secret: %+v", res.Error)
	}
	if res.Body["echo"] != redactedMarker {
		t.Fatalf("short secret not redacted: %+v", res.Body)
	}
}

func TestRedirectRebindsTransportToVerifiedHop(t *testing.T) {
	var destHits int
	dest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destHits++
		if r.URL.Path != "/ok" {
			t.Fatalf("dest path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"via":"dest"}`))
	}))
	t.Cleanup(dest.Close)
	_, destPortStr, err := net.SplitHostPort(strings.TrimPrefix(dest.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	destPort, err := strconv.Atoi(destPortStr)
	if err != nil {
		t.Fatal(err)
	}

	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, dest.URL+"/ok", http.StatusFound)
	}))
	t.Cleanup(src.Close)
	_, srcPortStr, err := net.SplitHostPort(strings.TrimPrefix(src.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	srcPort, err := strconv.Atoi(srcPortStr)
	if err != nil {
		t.Fatal(err)
	}

	conn := httpConn([]string{"127.0.0.1"}, []string{"127.0.0.1"}, []string{"GET"}, []string{"/"})
	conn.Policy.Ports = []int{srcPort, destPort}
	conn.Policy.AllowRedirects = true
	conn.Policy.MaxRedirects = 2
	req := baseHTTPReq(conn, http.MethodGet, "/", nil)
	req.Resolver = mapResolver{"127.0.0.1": []net.IP{net.ParseIP("127.0.0.1")}}
	res := Execute(context.Background(), req)
	if !res.OK {
		t.Fatalf("rebind redirect: %+v", res.Error)
	}
	if destHits != 1 {
		t.Fatalf("dest hits = %d (transport did not follow the verified hop)", destHits)
	}
	if res.Body["via"] != "dest" {
		t.Fatalf("body = %+v", res.Body)
	}
}

func TestHopTransportDeniesMetadataRedirect(t *testing.T) {
	cases := []struct {
		name string
		host string
		ip   string
	}{
		{name: "ipv4-imds", host: "169.254.169.254", ip: "169.254.169.254"},
		{name: "ipv6-imds", host: "fd00:ec2::254", ip: "fd00:ec2::254"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "http://"+net.JoinHostPort(tc.host, "80")+"/latest/meta-data", http.StatusFound)
			}))
			t.Cleanup(src.Close)
			_, srcPortStr, err := net.SplitHostPort(strings.TrimPrefix(src.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}
			srcPort, err := strconv.Atoi(srcPortStr)
			if err != nil {
				t.Fatal(err)
			}

			conn := httpConn([]string{"127.0.0.1", tc.host}, []string{"127.0.0.1", tc.ip}, []string{"GET"}, []string{"/"})
			conn.Policy.Ports = []int{srcPort, 80}
			conn.Policy.AllowRedirects = true
			conn.Policy.MaxRedirects = 2
			conn.Policy.AllowPrivateDestinations = true
			req := baseHTTPReq(conn, http.MethodGet, "/", nil)
			req.Resolver = mapResolver{
				"127.0.0.1": []net.IP{net.ParseIP("127.0.0.1")},
				tc.host:     []net.IP{net.ParseIP(tc.ip)},
			}
			res := Execute(context.Background(), req)
			if res.OK || res.Error == nil || (res.Error.Code != CodeSSRFDenied && res.Error.Code != CodeRedirectDenied) {
				t.Fatalf("hop transport metadata redirect %s: %+v", tc.name, res.Error)
			}
			if res.Error != nil && strings.Contains(res.Error.Message, tc.ip) {
				t.Fatalf("hop transport problem leaked address %s: %s", tc.ip, res.Error.Message)
			}
		})
	}
}

func TestEmailTemplateSchemaTypes(t *testing.T) {
	mailer := &CaptureMailer{}
	req := EmailRequest{
		ConnectionID: "99999999-9999-4999-8999-999999999999",
		WorkspaceID:  "ws-1",
		Payload:      map[string]any{"service": 7},
		Permissions:  operatorPerms(),
		Connection:   ConnectionContext{ID: "c1", WorkspaceID: "ws-1", Type: ConnectionSMTP, Published: true},
		Recipients:   RecipientListContext{ID: "r1", WorkspaceID: "ws-1", Published: true, Emails: []string{"ops@example.com"}},
		Template: TemplateContext{
			ID: "t1", WorkspaceID: "ws-1", Published: true, Subject: "Alert", Body: "Service {service} is degraded.",
			InputSchema: map[string]any{
				"type":       "object",
				"required":   []any{"service"},
				"properties": map[string]any{"service": map[string]any{"type": "string"}},
			},
		},
		Mailer: mailer,
	}
	res := ExecuteEmail(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeTemplateDenied {
		t.Fatalf("typed template: %+v", res.Error)
	}
}
