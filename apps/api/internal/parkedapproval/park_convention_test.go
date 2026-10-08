package parkedapproval

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path"
	"path/filepath"
	"regexp"
	"sort"
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
//
// TestParkLockHoldersNeverTakeMembershipLock (below) adds that no caller
// of LockWorkspaceForPark can reach LockWorkspaceMembership.

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

// A transaction holding the workspace row FOR SHARE (LockWorkspaceForPark)
// must never go on to take it FOR NO KEY UPDATE (identity
// LockWorkspaceMembership, or GuardLastAdmin, which calls it): two such
// transactions each hold the share lock and wait for the other's to
// upgrade, a deadlock. This test builds a call graph over every non-test
// function in apps/api and fails if a function that calls
// LockWorkspaceForPark can reach either membership lock.
//
// Edges: a plain call resolves in the same package; pkg.Func resolves
// through the file's imports of this module; any other selector call
// (a method on p, s, tx, ...) resolves by name to every function or
// method in the same package. That over-approximates, so the check errs
// toward failing. Calls inside closures count for the enclosing function.
// Calls through function values and interfaces in other packages are not
// followed; the positive control below proves the graph does reach the
// membership lock from the known membership paths.

const apiModule = "github.com/bbengt1/flowforge/apps/api/"

var membershipLocks = []string{
	"internal/identity.LockWorkspaceMembership",
	"internal/identity.GuardLastAdmin",
}

// callGraph maps "pkgdir.Name" to the "pkgdir.Name" keys it may call.
// Methods are keyed by name only, so same-named methods share a node.
func callGraph(files []parsedFile) map[string]map[string]bool {
	g := map[string]map[string]bool{}
	for _, pf := range files {
		dir := path.Dir(pf.rel)
		imports := map[string]string{}
		for _, im := range pf.file.Imports {
			ip, err := strconv.Unquote(im.Path.Value)
			if err != nil || !strings.HasPrefix(ip, apiModule) {
				continue
			}
			rel := strings.TrimPrefix(ip, apiModule)
			alias := path.Base(rel)
			if im.Name != nil {
				alias = im.Name.Name
			}
			imports[alias] = rel
		}
		for _, decl := range pf.file.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			from := dir + "." + fd.Name.Name
			if g[from] == nil {
				g[from] = map[string]bool{}
			}
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				switch fn := call.Fun.(type) {
				case *ast.Ident:
					g[from][dir+"."+fn.Name] = true
				case *ast.SelectorExpr:
					if x, ok := fn.X.(*ast.Ident); ok {
						if rel, ok := imports[x.Name]; ok {
							g[from][rel+"."+fn.Sel.Name] = true
							return true
						}
					}
					g[from][dir+"."+fn.Sel.Name] = true
				}
				return true
			})
		}
	}
	return g
}

// pathTo returns a call chain from root to any target, or nil.
func pathTo(g map[string]map[string]bool, root string, targets []string) []string {
	want := map[string]bool{}
	for _, t := range targets {
		want[t] = true
	}
	prev := map[string]string{root: ""}
	queue := []string{root}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if want[cur] {
			var chain []string
			for n := cur; n != ""; n = prev[n] {
				chain = append([]string{n}, chain...)
			}
			return chain
		}
		next := make([]string, 0, len(g[cur]))
		for n := range g[cur] {
			next = append(next, n)
		}
		sort.Strings(next)
		for _, n := range next {
			if _, seen := prev[n]; !seen {
				if _, defined := g[n]; defined {
					prev[n] = cur
					queue = append(queue, n)
				}
			}
		}
	}
	return nil
}

func TestParkLockHoldersNeverTakeMembershipLock(t *testing.T) {
	g := callGraph(apiFiles(t))
	const parkLock = "internal/parkedapproval.LockWorkspaceForPark"
	var roots []string
	for fn, callees := range g {
		if fn != parkLock && callees[parkLock] {
			roots = append(roots, fn)
		}
	}
	sort.Strings(roots)
	for _, want := range []string{
		"internal/parkedapproval.Insert",
		"internal/approval.resyncWorkspace",
		"internal/wfstore.WaitJob",
	} {
		if index(roots, want) < 0 {
			t.Fatalf("park-lock callers %v miss %s; update this test if the code moved", roots, want)
		}
	}
	for _, root := range roots {
		if chain := pathTo(g, root, membershipLocks); chain != nil {
			t.Errorf("%s holds the workspace share lock and can reach a membership lock (FOR NO KEY UPDATE), which deadlocks: %s",
				root, strings.Join(chain, " -> "))
		}
	}
	// Positive control: the graph does reach the lock from membership paths.
	for _, fn := range []string{
		"internal/identity.SetMemberRoles",
		"internal/identity.RemoveMember",
		"internal/identity.DeleteGroupTx",
	} {
		if pathTo(g, fn, membershipLocks) == nil {
			t.Fatalf("call graph cannot reach a membership lock from %s; the check is blind", fn)
		}
	}
}
