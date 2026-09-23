// Command genroutes writes the OpenAPI document and the identity-proxy
// allowlist from the mux route table, or fails when the committed copies
// are stale.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi"
)

func main() {
	check := flag.Bool("check", false, "exit 1 when committed generated artifacts differ from the route table")
	flag.Parse()
	if err := run(*check); err != nil {
		fmt.Fprintf(os.Stderr, "genroutes: %v\n", err)
		os.Exit(1)
	}
}

func run(check bool) error {
	root, err := apiRoot()
	if err != nil {
		return err
	}
	specPath := filepath.Join(root, "openapi", "openapi.yaml")
	allowPath := filepath.Join(root, "..", "web", "src", "lib", "identity-proxy-allowlist.gen.ts")
	existing, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	routes := httpapi.Routes(nil)
	spec, err := httpapi.RenderOpenAPI(routes, existing)
	if err != nil {
		return err
	}
	allow, err := httpapi.RenderProxyAllowlist(routes)
	if err != nil {
		return err
	}
	if check {
		committed, err := os.ReadFile(allowPath)
		if err != nil {
			return err
		}
		var stale []string
		if !bytes.Equal(spec, existing) {
			stale = append(stale, "apps/api/openapi/openapi.yaml")
		}
		if !bytes.Equal(allow, committed) {
			stale = append(stale, "apps/web/src/lib/identity-proxy-allowlist.gen.ts")
		}
		if len(stale) > 0 {
			return fmt.Errorf("generated route artifacts are stale (%s); regenerate with: go run ./cmd/genroutes", strings.Join(stale, ", "))
		}
		return nil
	}
	if err := os.WriteFile(specPath, spec, 0o644); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(allowPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(allowPath, allow, 0o644)
}

func apiRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "openapi", "openapi.yaml")); err == nil {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("apps/api module root not found from %s", dir)
		}
		dir = parent
	}
}
