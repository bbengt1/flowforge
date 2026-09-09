package httpnotify

import (
	"context"
	"net"
	"strings"
	"testing"
)

func TestSSRFReasonPrivateAndLoopback(t *testing.T) {
	denied := []string{
		"127.0.0.1",
		"127.0.0.2",
		"::1",
		"10.0.0.1",
		"10.255.255.255",
		"172.16.0.1",
		"172.31.255.254",
		"192.168.0.1",
		"192.168.255.255",
		"169.254.1.1",
		"169.254.169.254",
		"fe80::1",
		"fd00::1",
		"fc00::1",
		"100.64.0.1",
		"100.127.255.255",
		"0.0.0.0",
		"::",
		"224.0.0.1",
	}
	for _, raw := range denied {
		ip := net.ParseIP(raw)
		if ip == nil {
			t.Fatalf("parse %s", raw)
		}
		if ok, why := ssrfReason(ip, false); !ok {
			t.Fatalf("%s must be denied by default", raw)
		} else if strings.Contains(why, raw) {
			t.Fatalf("reason leaked %s: %s", raw, why)
		}
	}

	public := []string{"8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "172.32.0.1", "11.0.0.1"}
	for _, raw := range public {
		ip := net.ParseIP(raw)
		if ip == nil {
			t.Fatalf("parse %s", raw)
		}
		if denied, why := ssrfReason(ip, false); denied {
			t.Fatalf("public %s denied: %s", raw, why)
		}
	}

	if denied, _ := ssrfReason(net.ParseIP("10.1.2.3"), true); denied {
		t.Fatal("RFC1918 must be allowed when opted in")
	}
	if denied, _ := ssrfReason(net.ParseIP("127.0.0.1"), true); denied {
		t.Fatal("loopback must be allowed when opted in")
	}
	if denied, _ := ssrfReason(net.ParseIP("169.254.169.254"), true); !denied {
		t.Fatal("metadata must stay denied even when private destinations are opted in")
	}
	if denied, _ := ssrfReason(net.ParseIP("169.254.1.1"), true); !denied {
		t.Fatal("link-local must stay denied even when private destinations are opted in")
	}
	if denied, _ := ssrfReason(net.ParseIP("fe80::1"), true); !denied {
		t.Fatal("IPv6 link-local must stay denied even when private destinations are opted in")
	}
}

func TestResolveHostnameChecksAfterDNS(t *testing.T) {
	res, err := ResolveHostname(context.Background(), mapResolver{
		"status.example.com": []net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("192.168.0.5")},
	}, "status.example.com", false)
	if err == nil || err.Code != CodeSSRFDenied {
		t.Fatalf("rebinding resolve: res=%+v err=%+v", res, err)
	}
	if strings.Contains(err.Message, "192.168.0.5") {
		t.Fatalf("resolve problem leaked address: %s", err.Message)
	}

	ok, err := ResolveHostname(context.Background(), mapResolver{
		"status.example.com": []net.IP{net.ParseIP("8.8.8.8")},
	}, "status.example.com", false)
	if err != nil || len(ok.Addresses) != 1 || !ok.Addresses[0].Equal(net.ParseIP("8.8.8.8")) {
		t.Fatalf("public resolve: %+v %+v", ok, err)
	}

	_, err = ResolveHostname(context.Background(), mapResolver{
		"localhost": []net.IP{net.ParseIP("127.0.0.1")},
	}, "localhost", false)
	if err == nil || err.Code != CodeSSRFDenied {
		t.Fatalf("localhost: %+v", err)
	}
}

func TestConnectionContextFromSpecAllowPrivateFailClosed(t *testing.T) {
	ctx := ConnectionContextFromSpec("c1", map[string]any{
		"type": "http",
		"endpointPolicy": map[string]any{
			"hosts": []any{"status.example.com"},
		},
	})
	if ctx.Policy.AllowPrivateDestinations {
		t.Fatal("unset allowPrivateDestinations must be false")
	}
	ctx = ConnectionContextFromSpec("c1", map[string]any{
		"type": "http",
		"endpointPolicy": map[string]any{
			"allowPrivateDestinations": true,
		},
	})
	if !ctx.Policy.AllowPrivateDestinations {
		t.Fatal("explicit true must parse")
	}
	pol := PolicyContextFromRules("http", nil)
	if pol.AllowPrivateDestinations {
		t.Fatal("unset policy allowPrivateDestinations must be false")
	}
	pol = PolicyContextFromRules("http", map[string]any{KeyAllowPrivateDestinations: true})
	if !pol.AllowPrivateDestinations {
		t.Fatal("explicit policy true must parse")
	}
}
