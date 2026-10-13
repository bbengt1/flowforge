package fixturesuite

import (
	"encoding/base64"
	"net/url"
	"strings"
	"testing"
)

func TestSecuritySchemaIsStrict(t *testing.T) {
	ok := "id: x\ndrivers: [compose]\nchecks:\n  - {name: a, kind: http, method: GET, path: /api/v1/workflows, status: 200}\n"
	if _, err := DecodeSecuritySpec([]byte(ok)); err != nil {
		t.Fatal(err)
	}
	for name, src := range map[string]string{
		"unknown key":          strings.Replace(ok, "status: 200", "status: 200, bogus: 1", 1),
		"unknown kind":         strings.Replace(ok, "kind: http", "kind: nope", 1),
		"key kind ignores":     strings.Replace(ok, "status: 200", "status: 200, tables: [workflows]", 1),
		"unknown principal":    strings.Replace(ok, "kind: http", "kind: http, as: root", 1),
		"xfail part no check":  ok + "xfail:\n  - {part: zzz, reason: r, issue: \"#1\", drivers: [all]}\n",
		"xfail without issue":  ok + "xfail:\n  - {part: a, reason: r, issue: soon, drivers: [all]}\n",
		"duplicate check name": ok + "  - {name: a, kind: http, method: GET, path: /api/v1/workflows, status: 200}\n",
	} {
		if _, err := DecodeSecuritySpec([]byte(src)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestCanaryFormsCoverEncodings(t *testing.T) {
	v := "FFCANARY-CRED-1234+/="
	got := strings.Join(canaryForms(v, []string{"substring", "base64", "urlencoded"}), "\n")
	for _, want := range []string{v, base64.StdEncoding.EncodeToString([]byte(v)), url.QueryEscape(v)} {
		if !strings.Contains(got, want) {
			t.Fatalf("forms lack %q", want)
		}
	}
}

func TestSecuritySchemaS3Followup(t *testing.T) {
	ok := "id: x\ndrivers: [compose]\nchecks:\n  - {name: a, kind: csrf, as: viewer, session: valid, method: POST, path: /api/v1/workflows, status: 403}\n" +
		"  - {name: b, kind: audit, scenario: publish, detailsKeys: {workflow.publish: [a]}, detailsScopeKeys: {workflow.publish: [tenantId]}}\n"
	if _, err := DecodeSecuritySpec([]byte(ok)); err != nil {
		t.Fatal(err)
	}
	bad := strings.Replace(ok, "session: valid", "session: maybe", 1)
	if _, err := DecodeSecuritySpec([]byte(bad)); err == nil {
		t.Fatal("unknown session mode accepted")
	}
}
