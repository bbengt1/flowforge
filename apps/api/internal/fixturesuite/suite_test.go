package fixturesuite

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const fixturesDir = "fixtures"

// TestFixtureTagsAreValid is the schema + xfail lint. It needs no
// database, so it runs in every `go test ./...`.
func TestFixtureTagsAreValid(t *testing.T) {
	fixtures, err := LoadFixtures(fixturesDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatal("no fixtures found")
	}
	// Optional: FIXTURESUITE_EXTRA_DIR=<dir> also lints draft fixtures
	// (e.g. Terry's drafts) against the same strict schema.
	if extra := os.Getenv("FIXTURESUITE_EXTRA_DIR"); extra != "" {
		more, err := LoadFixtures(extra)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("extra fixtures valid: %d", len(more))
	}
}

// TestFixtures runs every fixture part on every driver it lists, strictly.
func TestFixtures(t *testing.T) {
	dir := fixturesDir
	// FIXTURESUITE_DIR=<dir> dry-runs draft fixtures locally (S2 prep).
	if d := os.Getenv("FIXTURESUITE_DIR"); d != "" {
		dir = d
	}
	fixtures, err := LoadFixtures(dir)
	if err != nil {
		t.Fatal(err)
	}
	env := newEnv(t)
	all := drivers()
	for _, fx := range fixtures {
		for _, p := range Parts(fx.Expect) {
			fx, p := fx, p
			t.Run(fx.ID+"/"+p.Name+"/"+p.Driver, func(t *testing.T) {
				guard, fails := runPart(t, env, fx, p, all[p.Driver])
				if len(guard) > 0 {
					// today: guards must hold even while a part is xfail.
					t.Errorf("%s/%s/%s today guard failed: %v", fx.ID, p.Name, p.Driver, guard)
				}
				outcome, msg := Verdict(fx.ID+"/"+p.Name, p.Driver, p.XFail, fails)
				t.Logf("%s %s/%s/%s %v", outcome, fx.ID, p.Name, p.Driver, fails)
				if outcome.Failing() {
					t.Error(msg)
				}
			})
		}
	}
}

// runPart returns today-guard failures and the failures strict xfail
// judges. A part with today/target asserts today as a guard and judges
// target; otherwise it judges the block itself.
func runPart(t *testing.T, env *Env, fx Fixture, p Part, d Driver) (guard, fails []string) {
	t.Helper()
	b := p.Block
	if b.Today != nil || b.Target != nil {
		if b.Today != nil {
			guard = evaluate(t, env, fx, *b.Today, b.File, b.Patch, d)
		}
		if b.Target == nil {
			return guard, []string{"no target block"}
		}
		tgt := *b.Target
		if tgt.File == "" {
			tgt.File = b.File
		}
		return guard, evaluate(t, env, fx, tgt, tgt.File, b.Patch, d)
	}
	return nil, evaluate(t, env, fx, b, b.File, b.Patch, d)
}

// evaluate seeds a throwaway workspace and checks one block. It returns
// failures instead of failing the test so strict xfail can judge them.
func evaluate(t *testing.T, env *Env, fx Fixture, b Block, file string, patch Patch, d Driver) []string {
	t.Helper()
	var fails []string
	failf := func(f string, a ...any) { fails = append(fails, fmt.Sprintf(f, a...)) }
	if pend := b.pendingKeys(); len(pend) > 0 {
		failf("not evaluated by the harness yet: %v", pend)
	}
	if file == "" {
		file = "workflow.yaml"
	}
	raw, err := os.ReadFile(filepath.Join(fx.Dir, file))
	if err != nil {
		return append(fails, err.Error())
	}
	src, err := ApplyPatch(string(raw), patch)
	if err != nil {
		return append(fails, err.Error())
	}
	w := env.NewWorkspace(t, fx.ID)
	owner := w.Users["owner"]
	want := b.Publish
	if want == nil {
		want = &HTTPExpect{Status: http.StatusCreated}
	}
	// The API validates the definition when the draft is saved, so an
	// invalid workflow is refused by POST /workflows (400
	// invalid-workflow) before publish. expect.yaml `publish:` covers
	// create + publish: a refused create is checked as the publish answer.
	draft, res := w.Create(owner, src)
	if res.Status != http.StatusCreated {
		checkHTTP(failf, "publish (refused at create)", *want, res)
		return fails
	}
	versionID, res := w.Publish(owner, draft)
	if !checkHTTP(failf, "publish", *want, res) || res.Status != http.StatusCreated {
		return fails
	}
	if b.Run == nil && len(b.Steps) == 0 && b.Audit == nil && b.Start == nil {
		return fails
	}
	execID, res := w.Start(owner, draft.WorkflowID, versionID, nil)
	want = b.Start
	if want == nil {
		want = &HTTPExpect{Status: http.StatusCreated}
	}
	if !checkHTTP(failf, "start", *want, res) || res.Status != http.StatusCreated {
		return fails
	}
	if err := d.Drive(t, w); err != nil {
		return append(fails, "drive: "+err.Error())
	}
	run := w.Observe(t, execID)
	if b.Run != nil {
		if len(b.Run.Status) > 0 && !b.Run.Status.Has(run.Status) {
			failf("run status = %s (%s), want one of %v", run.Status, run.Reason, b.Run.Status)
		}
		if b.Run.StatusReason != nil && *b.Run.StatusReason != run.Reason {
			failf("run statusReason = %q, want %q", run.Reason, *b.Run.StatusReason)
		}
	}
	if b.Run != nil {
		for node, want := range b.Run.Steps {
			if got, ok := run.Steps[node]; ok && !want.Has(got.Status) || !ok && !want.Has("skipped") {
				failf("run.steps %s = %q, want one of %v", node, got.Status, want)
			}
		}
	}
	for node, want := range b.Steps {
		got, ok := run.Steps[node]
		switch {
		case !ok && want.Status.Has("skipped"):
			// A step that never dispatched may have no row (see report Q3).
		case !ok:
			failf("step %s: no step row", node)
		default:
			if len(want.Status) > 0 && !want.Status.Has(got.Status) {
				failf("step %s = %q, want one of %v", node, got.Status, want.Status)
			}
			if want.Attempt != 0 && got.Attempt != want.Attempt {
				failf("step %s attempt = %d, want %d", node, got.Attempt, want.Attempt)
			}
			if want.Output != nil && !subset(norm(want.Output), norm(got.Output)) {
				failf("step %s output = %v, want ⊇ %v", node, got.Output, want.Output)
			}
		}
	}
	for action, n := range b.Audit {
		if got := run.Audit[action]; got != n {
			failf("audit %s = %d, want %d", action, got, n)
		}
	}
	return fails
}

func checkHTTP(failf func(string, ...any), what string, want HTTPExpect, res Response) bool {
	ok := true
	p := res.problem()
	if res.Status != want.Status {
		failf("%s = %d %s, want %d", what, res.Status, res.Body, want.Status)
		return false
	}
	if want.Code != "" && p.Code != want.Code {
		failf("%s code = %q, want %q", what, p.Code, want.Code)
		ok = false
	}
	for _, e := range want.Errors {
		found := false
		for _, g := range p.Errors {
			if g.Code == e.Code && (e.Path == "" || g.Path == e.Path) {
				found = true
			}
		}
		if !found {
			failf("%s errors[] lacks %+v (got %s)", what, e, res.Body)
			ok = false
		}
	}
	return ok
}

// norm makes YAML and JSON values comparable (ints vs float64).
func norm(v any) any {
	raw, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

// subset reports whether every key in want is present and equal in got.
func subset(want, got any) bool {
	wm, ok := want.(map[string]any)
	if !ok {
		return reflect.DeepEqual(want, got)
	}
	gm, ok := got.(map[string]any)
	if !ok {
		return false
	}
	for k, v := range wm {
		if !subset(v, gm[k]) {
			return false
		}
	}
	return true
}
