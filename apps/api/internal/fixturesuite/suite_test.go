package fixturesuite

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
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
				if !driverSelected(p.Driver) {
					t.Skipf("driver %s not in FIXTURESUITE_DRIVERS", p.Driver)
				}
				if !buildRuns(p.Block.Build) {
					t.Skipf("build: %s part (this binary fftest=%v)", p.Block.Build, fftestBuild)
				}
				if blackboxURL() != "" {
					if why := blackboxSkip(fx, p); why != "" {
						t.Skip(why)
					}
				}
				guard, fails, pending := runPart(t, env, fx, p, all[p.Driver])
				if len(guard) > 0 {
					// today: guards must hold even while a part is xfail.
					t.Errorf("%s/%s/%s today guard failed: %v", fx.ID, p.Name, p.Driver, guard)
				}
				outcome, msg := VerdictPending(fx.ID+"/"+p.Name, p.Driver, p.XFail, fails, pending)
				t.Logf("%s %s/%s/%s %v pending=%v", outcome, fx.ID, p.Name, p.Driver, fails, pending)
				r := Result{Suite: "fixtures", ID: fx.ID, Part: p.Name, Driver: p.Driver, Outcome: outcome, Failures: append(guard, fails...), Pending: pending}
				if p.XFail != nil {
					r.XFail = p.XFail.Issue
				}
				recordResult(t, r)
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
//
// pending lists harness-pending keys (accepted but not evaluated) of the
// judged block. They are not failures: VerdictPending decides. Pending
// keys in a today guard are guard failures (a guard must be fully
// checked).
func runPart(t *testing.T, env *Env, fx Fixture, p Part, d Driver) (guard, fails, pending []string) {
	t.Helper()
	b := p.Block
	if b.Today != nil || b.Target != nil {
		if b.Today != nil {
			if pend := b.Today.pendingKeys(); len(pend) > 0 {
				guard = append(guard, fmt.Sprintf("today: not evaluated by the harness yet: %v", pend))
			}
			gf, gp := evaluate(t, env, fx, *b.Today, b.File, b.Patch, d)
			guard = append(guard, gf...)
			for _, k := range gp {
				guard = append(guard, "today: not evaluated by the harness yet: "+k)
			}
		}
		if b.Target == nil {
			return guard, []string{"no target block"}, nil
		}
		tgt := *b.Target
		if tgt.File == "" {
			tgt.File = b.File
		}
		f, reached := evaluate(t, env, fx, tgt, tgt.File, b.Patch, d)
		return guard, f, append(tgt.pendingKeys(), reached...)
	}
	f, reached := evaluate(t, env, fx, b, b.File, b.Patch, d)
	return nil, f, append(b.pendingKeys(), reached...)
}

// evaluate seeds a throwaway workspace and checks one block. It returns
// failures instead of failing the test so strict xfail can judge them,
// plus "reached" harness-pending keys: keys the harness cannot evaluate
// yet that the part got far enough to need (import equivalence, resume
// route). They go to VerdictPending, never to failures.
func evaluate(t *testing.T, env *Env, fx Fixture, b Block, file string, patch Patch, d Driver) (fails, reached []string) {
	t.Helper()
	failf := func(f string, a ...any) { fails = append(fails, fmt.Sprintf(f, a...)) }
	if file == "" {
		file = "workflow.yaml"
	}
	raw, err := os.ReadFile(filepath.Join(fx.Dir, file))
	if err != nil {
		return append(fails, err.Error()), reached
	}
	src, err := ApplyPatch(string(raw), patch)
	if err != nil {
		return append(fails, err.Error()), reached
	}
	w := env.NewWorkspace(t, fx.ID)
	owner := w.Users["owner"]
	defer func() {
		if b.ExecutionsDelta != nil {
			if got := w.Executions(t); got != *b.ExecutionsDelta {
				failf("executionsDelta = %d, want %d", got, *b.ExecutionsDelta)
			}
		}
	}()
	for i, g := range b.PublishGuards {
		checkGuard(failf, w, fmt.Sprintf("publishGuards[%d]", i), src, g)
	}
	if b.ImportRoute != nil {
		body, err := os.ReadFile(filepath.Join(fx.Dir, "n8n.json"))
		if err != nil {
			return append(fails, "importRoute: "+err.Error()), reached
		}
		r := b.ImportRoute
		if !strings.HasPrefix(r.Path, "/api/v1/") {
			return append(fails, "importRoute: path must start with /api/v1/"), reached
		}
		checkHTTP(failf, "importRoute "+r.Path, HTTPExpect{Status: r.Status, Code: r.Code}, w.Do(owner, http.MethodPost, r.Path, json.RawMessage(body)))
	}
	if b.Import != nil {
		im := b.Import
		raw, err := os.ReadFile(filepath.Join(fx.Dir, im.From))
		if err != nil || !strings.HasPrefix(im.Path, "/api/v1/") {
			return append(fails, fmt.Sprintf("import: need a fixture file and an /api/v1/ path (%v)", err)), reached
		}
		res := w.Do(owner, http.MethodPost, im.Path, json.RawMessage(raw))
		if !checkHTTP(failf, "import "+im.Path, HTTPExpect{Status: im.Status}, res) {
			return fails, reached
		}
		// The importer answers: what it produced is not checkable yet.
		if im.EquivalentTo != "" {
			reached = append(reached, "import.equivalentTo")
		}
		if b.Export != nil {
			reached = append(reached, "export")
		}
		if b.Unsupported != nil {
			reached = append(reached, "unsupported")
		}
		return fails, reached
	}
	want := b.Publish
	if want == nil && b.WorkflowYamlPublish != nil {
		if file != "workflow.yaml" {
			return append(fails, "workflowYamlPublish on a part whose file is "+file), reached
		}
		want = b.WorkflowYamlPublish
	}
	if want == nil {
		want = &HTTPExpect{Status: http.StatusCreated}
	}
	// The API validates the definition when the draft is saved, so an
	// invalid workflow is refused by POST /workflows (400
	// invalid-workflow) before publish. expect.yaml `publish:` covers
	// create + publish: a refused create is checked as the publish answer.
	draft, res := w.Create(owner, src)
	if b.Save != nil {
		// save: checks the create alone; the publish is only checked
		// (and done) when publish: or a run expectation is also set.
		if !checkHTTP(failf, "save", *b.Save, res) || res.Status != http.StatusCreated || b.Publish == nil && !b.wantsRun() {
			return fails, reached
		}
	}
	if res.Status != http.StatusCreated {
		checkHTTP(failf, "publish (refused at create)", *want, res)
		return fails, reached
	}
	versionID, res := w.Publish(owner, draft)
	if !checkHTTP(failf, "publish", *want, res) || res.Status != http.StatusCreated {
		return fails, reached
	}
	if b.ResumeRoute != "" || b.WrongToken != nil {
		// The subject published: the resume route itself is not
		// evaluated yet (#652 defines the resume URL).
		reached = append(reached, "resume route")
	}
	actions := b.Actions
	if len(actions) == 0 {
		if !b.wantsRun() {
			return fails, reached
		}
		actions = []Action{{Verb: "start"}, {Verb: "drive"}}
	}
	execID, midChecked, killed := "", false, false
	retryWant := http.StatusCreated
	if b.HTTP != nil && b.HTTP.Retry != 0 {
		retryWant = b.HTTP.Retry
	}
	for _, a := range actions {
		if a.Verb != "start" && execID == "" {
			return append(fails, "action "+a.Verb+" before start"), reached
		}
		switch a.Verb {
		case "start":
			id, res := w.Start(owner, draft.WorkflowID, versionID, nil)
			want := b.Start
			if want == nil {
				want = &HTTPExpect{Status: http.StatusCreated}
			}
			if !checkHTTP(failf, "start", *want, res) || res.Status != http.StatusCreated {
				return fails, reached
			}
			execID = id
		case "drive":
			if err := d.Drive(t, w); err != nil {
				return append(fails, "drive: "+err.Error()), reached
			}
		case "drive-until-waiting":
			if err := d.DriveOnce(t, w); err != nil {
				return append(fails, "drive-until-waiting: "+err.Error()), reached
			}
			if b.MidRun != nil && !midChecked {
				midChecked = true
				mid := w.Observe(t, execID)
				checkStatus(failf, "midRun run", b.MidRun.Status, mid)
				checkSteps(failf, "midRun ", b.MidRun.Steps, mid)
			}
		case "retry-refused":
			if res := w.Retry(owner, execID); res.Status != http.StatusConflict {
				failf("retry-refused = %d %s, want 409", res.Status, res.Body)
			}
		case "publish-v2":
			raw2, err := os.ReadFile(filepath.Join(fx.Dir, a.Arg))
			if err != nil {
				return append(fails, "publish-v2: "+err.Error()), reached
			}
			d2, res := w.SaveDraft(owner, draft, string(raw2))
			if res.Status != http.StatusOK && res.Status != http.StatusCreated {
				return append(fails, fmt.Sprintf("publish-v2 save = %d %s", res.Status, res.Body)), reached
			}
			if _, res := w.Publish(owner, d2); res.Status != http.StatusCreated {
				return append(fails, fmt.Sprintf("publish-v2 publish = %d %s", res.Status, res.Body)), reached
			}
		case "retry":
			res := w.Retry(owner, execID)
			if res.Status != retryWant {
				failf("retry = %d %s, want %d", res.Status, res.Body, retryWant)
			}
		case "claim-and-die":
			claimed, err := d.ClaimAndDie(t, w)
			if err != nil {
				return append(fails, "claim-and-die: "+err.Error()), reached
			}
			if !claimed {
				return append(fails, "claim-and-die: no job to claim"), reached
			}
			killed = true
			w.gen++
		case "kill-runner":
			killed = true
			w.gen++
		case "new-runner":
			if !killed {
				failf("new-runner without kill-runner")
			}
			killed = false
		case "advance-clock", "set-now":
			dur, _ := a.duration() // validated at load
			env.Advance(dur)
		case "tick-recover":
			if err := env.api.TickRecover(env.ctx); err != nil {
				return append(fails, "tick-recover: "+err.Error()), reached
			}
		}
	}
	if b.MidRun != nil && !midChecked {
		failf("midRun set but no drive-until-waiting action")
	}
	if b.HTTP != nil && b.HTTP.RetryAsViewer != nil {
		checkHTTP(failf, "retry as viewer", *b.HTTP.RetryAsViewer, w.Retry(w.Users["viewer"], execID))
	}
	run := w.Observe(t, execID)
	if b.Run != nil {
		checkStatus(failf, "run", b.Run.Status, run)
		if b.Run.StatusReason != nil && *b.Run.StatusReason != run.Reason {
			failf("run statusReason = %q, want %q", run.Reason, *b.Run.StatusReason)
		}
		for node, want := range b.Run.Steps {
			if got, ok := run.Steps[node]; ok && !want.Has(got.Status) || !ok && !want.Has("skipped") {
				failf("run.steps %s = %q, want one of %v", node, got.Status, want)
			}
		}
	}
	checkSteps(failf, "", b.Steps, run)
	if b.ErrorWorkflowFires != nil {
		// Each part has a fresh workspace: any execution besides this one
		// is an error-workflow run.
		fired := w.Executions(t) > 1
		if fired != *b.ErrorWorkflowFires {
			failf("errorWorkflowFires = %v, want %v", fired, *b.ErrorWorkflowFires)
		}
	}
	for _, node := range sortedNodes(run.Steps) {
		for _, bad := range b.NoStepStatusIn {
			if run.Steps[node].Status == bad {
				failf("step %s = %q, but noStepStatusIn %v", node, bad, b.NoStepStatusIn)
			}
		}
	}
	for node, j := range b.Jobs {
		if j.Count != nil {
			if got := w.JobCount(t, execID, node); got != *j.Count {
				failf("jobs %s count = %d, want %d", node, got, *j.Count)
			}
		}
	}
	for action, n := range b.Audit {
		if got := run.Audit[action]; got != n {
			failf("audit %s = %d, want %d", action, got, n)
		}
	}
	for action, want := range b.AuditDetails {
		rows := run.AuditRows[action]
		if len(rows) == 0 {
			failf("auditDetails %s: no rows", action)
		}
		for i, got := range rows {
			if !subset(norm(want), norm(got)) {
				failf("auditDetails %s[%d] = %v, want ⊇ %v", action, i, got, want)
			}
		}
	}
	return fails, reached
}

// wantsRun reports whether the block expects anything of a started run.
func (b Block) wantsRun() bool {
	return len(b.Actions) > 0 || b.Run != nil || len(b.Steps) > 0 || b.Audit != nil || b.Start != nil || len(b.Jobs) > 0 ||
		b.AuditDetails != nil || len(b.NoStepStatusIn) > 0 || b.HTTP != nil || b.ErrorWorkflowFires != nil
}

func checkStatus(failf func(string, ...any), what string, want StringSet, run Run) {
	if len(want) > 0 && !want.Has(run.Status) {
		failf("%s status = %s (%s), want one of %v", what, run.Status, run.Reason, want)
	}
}

func sortedNodes(m map[string]Step) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// checkSteps evaluates per-node expectations against the latest attempt
// (and, for attempts/attemptStatuses/attemptErrors, every attempt).
func checkSteps(failf func(string, ...any), prefix string, steps map[string]StepExpect, run Run) {
	for node, want := range steps {
		got, ok := run.Steps[node]
		switch {
		case !ok && want.Status.Has("skipped") && want.SkipReason == "":
			// A step that never dispatched may have no row (see report Q3).
		case !ok:
			failf("%sstep %s: no step row", prefix, node)
		default:
			if len(want.Status) > 0 && !want.Status.Has(got.Status) {
				failf("%sstep %s = %q, want one of %v", prefix, node, got.Status, want.Status)
			}
			if want.Attempt != 0 && got.Attempt != want.Attempt {
				failf("%sstep %s attempt = %d, want %d", prefix, node, got.Attempt, want.Attempt)
			}
			if want.Output != nil && !subset(norm(want.Output), norm(got.Output)) {
				failf("%sstep %s output = %v, want ⊇ %v", prefix, node, got.Output, want.Output)
			}
			if want.Input != nil && !reflect.DeepEqual(norm(want.Input), norm(got.Input)) {
				failf("%sstep %s input = %v, want exactly %v", prefix, node, got.Input, want.Input)
			}
			if want.ErrorHandling != "" {
				wantEH := want.ErrorHandling
				if wantEH == "none" {
					wantEH = ""
				}
				if got.ErrorHandling != wantEH {
					failf("%sstep %s errorHandling = %q, want %q", prefix, node, got.ErrorHandling, want.ErrorHandling)
				}
			}
			if want.NoOutput && len(got.Output) > 0 {
				failf("%sstep %s output = %v, want none", prefix, node, got.Output)
			}
			if want.Port != "" && fmt.Sprint(got.Output["port"]) != want.Port {
				failf("%sstep %s port = %v, want %q (output %v)", prefix, node, got.Output["port"], want.Port, got.Output)
			}
			if want.SkipReason != "" && got.SkipReason != want.SkipReason {
				failf("%sstep %s skipReason = %q, want %q", prefix, node, got.SkipReason, want.SkipReason)
			}
			if want.Error != nil && !errorMatches(*want.Error, got.Error) {
				failf("%sstep %s error = %v, want %+v", prefix, node, got.Error, *want.Error)
			}
			all := run.Attempts[node]
			if want.Attempts != 0 && len(all) != want.Attempts {
				failf("%sstep %s attempts = %d, want %d", prefix, node, len(all), want.Attempts)
			}
			if len(want.AttemptStatuses) > 0 {
				var gs []string
				for _, a := range all {
					gs = append(gs, a.Status)
				}
				if !reflect.DeepEqual(gs, want.AttemptStatuses) {
					failf("%sstep %s attemptStatuses = %v, want %v", prefix, node, gs, want.AttemptStatuses)
				}
			}
			if len(want.AttemptErrors) > 0 {
				var errs []map[string]any
				for _, a := range all {
					if len(a.Error) > 0 {
						errs = append(errs, a.Error)
					}
				}
				okAll := len(errs) == len(want.AttemptErrors)
				for i := 0; okAll && i < len(errs); i++ {
					okAll = errorMatches(want.AttemptErrors[i], errs[i])
				}
				if !okAll {
					failf("%sstep %s attemptErrors = %v, want %+v", prefix, node, errs, want.AttemptErrors)
				}
			}
		}
	}
}

func errorMatches(want StepError, got map[string]any) bool {
	if got == nil {
		return false
	}
	if want.Code != "" && fmt.Sprint(got["code"]) != want.Code {
		return false
	}
	return want.Message == "" || fmt.Sprint(got["message"]) == want.Message
}

// checkGuard applies one publish guard's patch and expects a refusal at
// create or, when the draft saves, at publish. A guard never starts a run.
func checkGuard(failf func(string, ...any), w *Workspace, what, src string, g PublishGuard) {
	patched, err := ApplyPatch(src, g.Patch)
	if err != nil {
		failf("%s: %v", what, err)
		return
	}
	want := HTTPExpect{Status: g.Status, Code: g.Code, Errors: g.Errors}
	if want.Status == 0 {
		want.Status = http.StatusBadRequest
	}
	owner := w.Users["owner"]
	draft, res := w.Create(owner, patched)
	if res.Status == http.StatusCreated {
		_, res = w.Publish(owner, draft)
	}
	checkHTTP(failf, what, want, res)
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
