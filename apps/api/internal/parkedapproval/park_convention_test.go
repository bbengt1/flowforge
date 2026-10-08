package parkedapproval

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

// Every pending targeted approval (and every approver snapshot row) is
// written under LockWorkspaceForPark, so a park or a retarget can never
// read the approver set while a membership change is in flight. This test
// fails when a new code path writes one some other way.
//
// Rules, over every non-test Go file in apps/api:
//   - SQL that inserts into approvals with approvers_digest lives only in
//     parkedapproval/park.go (Insert). Other approvals inserts are
//     untargeted and must not set approvers_digest.
//   - SQL that sets approvers_digest on an existing row lives only in
//     approval/resync.go.
//   - SQL that inserts approver snapshot rows lives only in
//     parkedapproval/snapshot.go (WriteSnapshot).
//   - parkedapproval.Insert is called only from wfstore's
//     ensureParkedApprovalTx; parkedapproval.WriteSnapshot only from
//     approval's resyncTargets.
//   - Every caller of ensureParkedApprovalTx calls LockWorkspaceForPark
//     before lockExecutionTx; resyncWorkspace calls it before
//     lockResyncParents; Insert calls it before ResolveSnapshot.

var (
	insertApprovals   = regexp.MustCompile(`(?is)\bINSERT\s+INTO\s+approvals\s*\(`)
	updateDigest      = regexp.MustCompile(`(?is)\bUPDATE\s+approvals\b.*\bapprovers_digest\s*=`)
	insertSnapshotRow = regexp.MustCompile(`(?is)\bINSERT\s+INTO\s+approval_approver_(users|groups)\b`)
)

type parsedFile struct {
	rel  string
	file *ast.File
}

func apiFiles(t *testing.T) []parsedFile {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	var out []parsedFile
	fset := token.NewFileSet()
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
		rel, _ := filepath.Rel(root, path)
		out = append(out, parsedFile{rel: filepath.ToSlash(rel), file: f})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 50 {
		t.Fatalf("walked only %d files under %s", len(out), root)
	}
	return out
}

// callName is "pkg.Func" for a selector call and "Func" for a plain one.
func callName(call *ast.CallExpr) string {
	switch fn := call.Fun.(type) {
	case *ast.Ident:
		return fn.Name
	case *ast.SelectorExpr:
		if x, ok := fn.X.(*ast.Ident); ok {
			return x.Name + "." + fn.Sel.Name
		}
		return fn.Sel.Name
	}
	return ""
}

// funcCalls lists, per top-level function, the calls it makes in source order.
func funcCalls(f *ast.File) map[string][]string {
	out := map[string][]string{}
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Body == nil {
			continue
		}
		name := fd.Name.Name
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if c := callName(call); c != "" {
					out[name] = append(out[name], c)
				}
			}
			return true
		})
	}
	return out
}

func index(calls []string, name string) int {
	for i, c := range calls {
		if c == name {
			return i
		}
	}
	return -1
}

// requireBefore fails unless fn calls first before second (both present).
func requireBefore(t *testing.T, where string, calls []string, first, second string) {
	t.Helper()
	i, j := index(calls, first), index(calls, second)
	if i < 0 || j < 0 || i > j {
		t.Errorf("%s must call %s before %s (calls: %v)", where, first, second, calls)
	}
}

func TestPendingTargetedApprovalsGoThroughParkLock(t *testing.T) {
	files := apiFiles(t)
	var ensureCallers []string
	sawInsert, sawResync, sawPark := false, false, false
	for _, pf := range files {
		// SQL text.
		ast.Inspect(pf.file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			sql, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			if insertApprovals.MatchString(sql) && strings.Contains(sql, "approvers_digest") && pf.rel != "internal/parkedapproval/park.go" {
				t.Errorf("%s inserts a targeted approval outside parkedapproval.Insert", pf.rel)
			}
			if updateDigest.MatchString(sql) && pf.rel != "internal/approval/resync.go" {
				t.Errorf("%s retargets an approval outside approval resync", pf.rel)
			}
			if insertSnapshotRow.MatchString(sql) && pf.rel != "internal/parkedapproval/snapshot.go" {
				t.Errorf("%s writes approver snapshot rows outside parkedapproval.WriteSnapshot", pf.rel)
			}
			return true
		})

		calls := funcCalls(pf.file)
		pkg := pf.file.Name.Name
		for fn, cs := range calls {
			where := pf.rel + ":" + fn
			for _, c := range cs {
				switch {
				case c == "parkedapproval.Insert" || (pkg == "parkedapproval" && c == "Insert"):
					if pf.rel != "internal/wfstore/postgres_dispatch.go" || fn != "ensureParkedApprovalTx" {
						t.Errorf("%s calls parkedapproval.Insert; only wfstore ensureParkedApprovalTx may", where)
					}
					sawInsert = true
				case c == "parkedapproval.WriteSnapshot":
					if pf.rel != "internal/approval/resync.go" || fn != "resyncTargets" {
						t.Errorf("%s calls parkedapproval.WriteSnapshot; only approval resyncTargets may", where)
					}
				case c == "ensureParkedApprovalTx" && pkg == "wfstore":
					ensureCallers = append(ensureCallers, where)
					requireBefore(t, where, cs, "parkedapproval.LockWorkspaceForPark", "lockExecutionTx")
				}
			}
			if pf.rel == "internal/approval/resync.go" && fn == "resyncWorkspace" {
				requireBefore(t, where, cs, "parkedapproval.LockWorkspaceForPark", "lockResyncParents")
				sawResync = true
			}
			if pf.rel == "internal/parkedapproval/park.go" && fn == "Insert" {
				requireBefore(t, where, cs, "LockWorkspaceForPark", "ResolveSnapshot")
				sawPark = true
			}
		}
	}
	if !sawInsert || !sawResync || !sawPark || len(ensureCallers) == 0 {
		t.Fatalf("convention scan found insert=%v resync=%v park=%v ensureCallers=%v; update this test if the code moved",
			sawInsert, sawResync, sawPark, ensureCallers)
	}
}
