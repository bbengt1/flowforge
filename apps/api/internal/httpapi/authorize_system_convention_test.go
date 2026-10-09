package httpapi

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// AuthorizeSystem and AuthorizeSystemTenancy may be called from exactly
// the scheduler tick and webhook ingress. A request handler must not
// fall back to a system scope.
func TestAuthorizeSystemAllowlist(t *testing.T) {
	root, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	allow := map[string]bool{
		"workflowhttp/scheduler_tick.go": true,
		"webhookhttp/webhook_ingress.go": true,
	}
	fset := token.NewFileSet()
	callers := map[string]struct{}{}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "testdata" || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || !systemAuthorizeCall(call) {
				return true
			}
			callers[rel] = struct{}{}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rel := range callers {
		got = append(got, rel)
	}
	sort.Strings(got)
	var want []string
	for rel := range allow {
		want = append(want, rel)
	}
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("AuthorizeSystem callers = %v, allowlist = %v", got, want)
	}
}

func systemAuthorizeCall(call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	if !ok || id.Name != "isolation" {
		return false
	}
	return sel.Sel.Name == "AuthorizeSystem" || sel.Sel.Name == "AuthorizeSystemTenancy"
}
