package identity

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Only SetUserStatus writes users.status, so every disable (instance SCIM,
// machine-principal revoke, any future path) runs the gate re-check that
// SetUserStatus starts after a disable. This scans the SQL in every
// non-test Go file under apps/api.
var (
	updateUserStatus = regexp.MustCompile(`(?is)\bUPDATE\s+users\b.*\bSET\b.*\bstatus\s*=`)
	insertUserStatus = regexp.MustCompile(`(?is)\bINSERT\s+INTO\s+users\s*\([^)]*\bstatus\b`)
	upsertUserStatus = regexp.MustCompile(`(?is)\bINSERT\s+INTO\s+users\b.*\bON\s+CONFLICT\b.*\bSET\b.*\bstatus\s*=`)
)

func TestOnlySetUserStatusWritesUserStatus(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	files, writers := 0, 0
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
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		files++
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		check := func(where string, n ast.Node) {
			ast.Inspect(n, func(n ast.Node) bool {
				lit, ok := n.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				sql, err := strconv.Unquote(lit.Value)
				if err != nil {
					return true
				}
				if updateUserStatus.MatchString(sql) || insertUserStatus.MatchString(sql) || upsertUserStatus.MatchString(sql) {
					if where != "internal/identity/postgres.go:SetUserStatus" {
						t.Errorf("%s writes users.status; only identity SetUserStatus may (it re-checks gates on disable)", where)
					}
					writers++
				}
				return true
			})
		}
		for _, decl := range f.Decls {
			if fd, ok := decl.(*ast.FuncDecl); ok {
				check(rel+":"+fd.Name.Name, fd)
				continue
			}
			check(rel, decl)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files < 50 || writers != 1 {
		t.Fatalf("scanned %d files, found %d users.status writers; want exactly SetUserStatus", files, writers)
	}
}
