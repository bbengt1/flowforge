package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"gopkg.in/yaml.v3"
)

func TestRouteTableIsRegisteredAndClassified(t *testing.T) {
	routes := Routes(nil)
	if len(routes) < 200 {
		t.Fatalf("route count = %d", len(routes))
	}
	seen := map[string]bool{}
	public := map[string]bool{}
	embed := map[string]bool{}
	for _, rt := range routes {
		key := rt.Method + " " + rt.Pattern
		if seen[key] {
			t.Fatalf("duplicate %s", key)
		}
		seen[key] = true
		switch rt.Auth {
		case AuthPublic:
			public[key] = true
		case AuthEmbed:
			embed[key] = true
		case AuthAuthenticated:
		default:
			t.Fatalf("%s auth %q", key, rt.Auth)
		}
		if rt.Proxy != ProxyBrowser && rt.Proxy != ProxyNone {
			t.Fatalf("%s proxy %q", key, rt.Proxy)
		}
	}
	wantPublic := []string{
		"GET /api/v1/health",
		"GET /api/v1/readiness",
		"GET /api/v1/bootstrap",
		"POST /api/v1/bootstrap/persistence",
		"POST /api/v1/bootstrap/admins",
		"POST /api/v1/bootstrap/public-url",
		"POST /api/v1/bootstrap/tls",
		"POST /api/v1/login",
		"POST /api/v1/oidc/start",
		"POST /api/v1/oidc/callback",
		"POST /api/v1/machine/token",
		"POST /api/v1/hooks/{publicId}",
	}
	if len(public) != len(wantPublic) {
		t.Fatalf("public routes = %v", keys(public))
	}
	for _, key := range wantPublic {
		if !public[key] {
			t.Fatalf("missing public route %s", key)
		}
	}
	wantEmbed := []string{
		"GET /api/v1/embed/catalog",
		"GET /api/v1/embed/jwks",
		"POST /api/v1/embed/exchange",
		"GET /api/v1/portal/adapter",
	}
	if len(embed) != len(wantEmbed) {
		t.Fatalf("embed routes = %v", keys(embed))
	}
	for _, key := range wantEmbed {
		if !embed[key] {
			t.Fatalf("missing embed route %s", key)
		}
		if routeByKey(routes, key).Proxy != ProxyBrowser {
			t.Fatalf("%s must be on the identity-proxy allowlist", key)
		}
	}
	// Mint and rotation require a principal. They are not anonymous embed doors.
	for _, key := range []string{
		"POST /api/v1/embed/assertions",
		"POST /api/v1/embed/keys/rotate",
		"POST /api/v1/portal/adapter/assertions",
	} {
		rt := routeByKey(routes, key)
		if rt.Auth != AuthAuthenticated || rt.Proxy != ProxyBrowser {
			t.Fatalf("%s classified auth=%s proxy=%s", key, rt.Auth, rt.Proxy)
		}
	}
	for _, key := range []string{
		"GET /api/v1/health",
		"GET /api/v1/readiness",
		"GET /api/v1/metrics",
		"GET /api/v1/openapi.yaml",
		"POST /api/v1/machine/token",
		"POST /api/v1/hooks/{publicId}",
		"POST /api/v1/jobs/claim",
		"POST /api/v1/jobs/{jobId}/heartbeat",
		"POST /api/v1/executions/{executionId}/artifacts",
		"POST /api/v1/executions/{executionId}/steps/{stepId}/logs",
		"POST /api/v1/retention/purge",
		"POST /api/v1/artifacts/{artifactId}/legal-hold",
		"GET /scim/v2/Users",
		"GET /api/v1/users/{userID}/lockout",
	} {
		if routeByKey(routes, key).Proxy != ProxyNone {
			t.Fatalf("%s must stay off the identity-proxy allowlist", key)
		}
	}
	if routeByKey(routes, "GET /api/v1/executions/{executionId}/steps/{stepId}/logs").Proxy != ProxyBrowser {
		t.Fatal("GET step logs is a browser route")
	}
	if routeByKey(routes, "GET /api/v1/workflows").Auth != AuthAuthenticated {
		t.Fatal("workflows are authenticated")
	}

	h := NewWithStore(nil, identity.NewMemory())
	for _, rt := range routes {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(rt.Method, samplePattern(rt.Pattern), nil)
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusNotFound && strings.Contains(rec.Body.String(), "The requested path does not exist.") {
			t.Fatalf("%s %s is not registered on the mux", rt.Method, rt.Pattern)
		}
	}
}

func TestGeneratedArtifactsMatchRouteTable(t *testing.T) {
	routes := Routes(nil)
	docPath := filepath.Join("..", "..", "openapi", "document.yaml")
	compPath := filepath.Join("..", "..", "openapi", "components.yaml")
	specPath := filepath.Join("..", "..", "openapi", "openapi.yaml")
	allowPath := filepath.Join("..", "..", "..", "web", "src", "lib", "identity-proxy-allowlist.gen.ts")
	document, err := os.ReadFile(docPath)
	if err != nil {
		t.Fatal(err)
	}
	components, err := os.ReadFile(compPath)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := RenderOpenAPI(routes, document, components)
	if err != nil {
		t.Fatal(err)
	}
	existing, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(spec) != string(existing) {
		t.Fatal("openapi.yaml is stale vs the route table; run: go run ./cmd/genroutes")
	}
	again, err := RenderOpenAPI(routes, document, components)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != string(spec) {
		t.Fatal("openapi render is not a fixed point")
	}
	mutated := bytes.Replace(existing, []byte("Generated from the route table"), []byte("Hand edited operation"), 1)
	if bytes.Equal(mutated, existing) {
		t.Fatal("expected a generated description to mutate")
	}
	if bytes.Contains(again, []byte("Hand edited operation")) || bytes.Equal(again, mutated) {
		t.Fatal("generator reproduced a hand edit of openapi.yaml")
	}
	if _, err := RenderOpenAPI(routes, append(append([]byte{}, document...), []byte("\npaths: {}\n")...), components); err == nil {
		t.Fatal("document.yaml with a paths key was accepted")
	}
	if _, err := RenderOpenAPI(routes, document, []byte("components: {}\npaths: {}\n")); err == nil {
		t.Fatal("components.yaml with a paths key was accepted")
	}
	if strings.Contains(string(spec), "Returns process liveness") || strings.Contains(string(spec), "password: \"") {
		t.Fatal("published spec copied hand-written path prose or a password example")
	}
	allow, err := RenderProxyAllowlist(routes)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := os.ReadFile(allowPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(allow) != string(committed) {
		t.Fatal("identity-proxy allowlist is stale vs the route table; run: go run ./cmd/genroutes")
	}

	var doc map[string]any
	if err := yaml.Unmarshal(spec, &doc); err != nil {
		t.Fatal(err)
	}
	rows, _ := doc["x-flowforge-routes"].([]any)
	if len(rows) != len(routes) {
		t.Fatalf("x-flowforge-routes = %d, routes = %d", len(rows), len(routes))
	}
	byKey := map[string]map[string]any{}
	for _, row := range rows {
		m, _ := row.(map[string]any)
		byKey[fmtMethod(m)+" "+fmtString(m["pattern"])] = m
	}
	paths, _ := doc["paths"].(map[string]any)
	for _, rt := range routes {
		m := byKey[rt.Method+" "+rt.Pattern]
		if m == nil {
			t.Fatalf("extension missing %s %s", rt.Method, rt.Pattern)
		}
		if m["auth"] != string(rt.Auth) || m["proxy"] != string(rt.Proxy) || m["path"] != rt.OpenAPIPath() {
			t.Fatalf("classification drift for %s %s: %#v", rt.Method, rt.Pattern, m)
		}
		if paths[rt.OpenAPIPath()] == nil {
			t.Fatalf("spec missing %s", rt.OpenAPIPath())
		}
		if rt.SpecRef != "" {
			item, _ := paths[rt.OpenAPIPath()].(map[string]any)
			if item["$ref"] != rt.SpecRef || len(item) != 1 {
				t.Fatalf("ops path %s = %#v, want $ref %s", rt.OpenAPIPath(), item, rt.SpecRef)
			}
		}
	}
	assertPathStubsHaveNoExamples(t, paths)
	for path := range paths {
		found := false
		for _, rt := range routes {
			if rt.OpenAPIPath() == path {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("spec path %s is not in the route table", path)
		}
	}
	assertNoSecretMaterial(t, string(spec))
	assertNoSecretMaterial(t, string(allow))
	assertNoSecretMaterial(t, string(components))
	assertNoDSNExamples(t, string(spec))
	assertNoDSNExamples(t, string(components))
}

func assertPathStubsHaveNoExamples(t *testing.T, paths map[string]any) {
	t.Helper()
	for path, raw := range paths {
		item, _ := raw.(map[string]any)
		if ref, ok := item["$ref"].(string); ok {
			if len(item) != 1 || !strings.HasPrefix(ref, "#/components/pathItems/") {
				t.Fatalf("%s $ref path is not a pathItems reference", path)
			}
			continue
		}
		if keyNamed(item, "example") || keyNamed(item, "examples") {
			t.Fatalf("%s generated path contains an example", path)
		}
	}
}

func keyNamed(v any, name string) bool {
	switch n := v.(type) {
	case map[string]any:
		for k, child := range n {
			if k == name || keyNamed(child, name) {
				return true
			}
		}
	case []any:
		for _, child := range n {
			if keyNamed(child, name) {
				return true
			}
		}
	}
	return false
}

func assertNoDSNExamples(t *testing.T, doc string) {
	t.Helper()
	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`(?i)(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp|nats)://`),
		regexp.MustCompile(`://[^/\s:]+:[^/\s@]+@`),
	}
	for _, re := range forbidden {
		if loc := re.FindStringIndex(doc); loc != nil {
			snippet := doc[loc[0]:min(loc[1], loc[0]+80)]
			t.Fatalf("DSN example in generated artifact: %q", snippet)
		}
	}
	passwordExample := regexp.MustCompile(`(?m)password:\s*"([^"]*)"`)
	for _, m := range passwordExample.FindAllStringSubmatch(doc, -1) {
		if strings.Trim(m[1], "*") != "" {
			t.Fatalf("password example in generated artifact: %q", m[0])
		}
	}
}

func assertNoSecretMaterial(t *testing.T, doc string) {
	t.Helper()
	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
		regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
		regexp.MustCompile(`\$2[aby]\$\d{2}\$`),
		regexp.MustCompile(`(?i)\b(client_secret|password|private_key|secret)\b\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}`),
		regexp.MustCompile(`\b(ghp_|xox[baprs]-|sk_live_)[A-Za-z0-9]+`),
	}
	for _, re := range forbidden {
		if loc := re.FindStringIndex(doc); loc != nil {
			snippet := doc[loc[0]:min(loc[1], loc[0]+80)]
			t.Fatalf("secret-like material in generated artifact: %q", snippet)
		}
	}
}

func routeByKey(routes []Route, key string) Route {
	for _, rt := range routes {
		if rt.Method+" "+rt.Pattern == key {
			return rt
		}
	}
	return Route{}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func samplePattern(pattern string) string {
	return regexp.MustCompile(`\{([^}]+)\}`).ReplaceAllStringFunc(pattern, func(raw string) string {
		name := raw[1 : len(raw)-1]
		switch paramKind(name) {
		case "segment":
			return "job-1"
		default:
			if name == "publicId" {
				return "wh_" + strings.Repeat("ab", 32)
			}
			return "11111111-1111-4111-8111-111111111111"
		}
	})
}

func fmtMethod(m map[string]any) string { return fmtString(m["method"]) }

func fmtString(v any) string {
	s, _ := v.(string)
	return s
}
