package isolation

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// No non-test production file passes a literal empty actor into
// Authorize or AuthorizeTenancy. System work calls AuthorizeSystem.
func TestNoLiteralEmptyActorAuthorize(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var hits []string
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "node_modules" || name == "testdata" || strings.HasPrefix(name, ".") {
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
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || !authorizeCall(file.Name.Name, call) {
				return true
			}
			if len(call.Args) < 2 {
				return true
			}
			if emptyStringLit(call.Args[1]) {
				hits = append(hits, rel+":"+fset.Position(call.Pos()).String())
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) > 0 {
		t.Fatalf("literal empty actor passed to Authorize:\n%s", strings.Join(hits, "\n"))
	}
}

func authorizeCall(pkg string, call *ast.CallExpr) bool {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		if pkg != "isolation" {
			return false
		}
		return fun.Name == "Authorize" || fun.Name == "AuthorizeTenancy"
	case *ast.SelectorExpr:
		id, ok := fun.X.(*ast.Ident)
		if !ok || id.Name != "isolation" {
			return false
		}
		return fun.Sel.Name == "Authorize" || fun.Sel.Name == "AuthorizeTenancy"
	default:
		return false
	}
}

func emptyStringLit(e ast.Expr) bool {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return false
	}
	v, err := strconv.Unquote(lit.Value)
	return err == nil && v == ""
}
