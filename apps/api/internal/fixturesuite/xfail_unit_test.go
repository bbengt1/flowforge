package fixturesuite

import (
	"strings"
	"testing"
)

func TestVerdictIsStrict(t *testing.T) {
	x := &XFail{Reason: "not yet", Issue: "#651"}
	cases := []struct {
		x     *XFail
		fails []string
		want  Outcome
		bad   bool
	}{
		{nil, nil, OutcomePass, false},
		{nil, []string{"boom"}, OutcomeFail, true},
		{x, []string{"boom"}, OutcomeXFail, false},
		{x, nil, OutcomeXPass, true},
	}
	for _, c := range cases {
		got, msg := Verdict("01-linear", "compose", c.x, c.fails)
		if got != c.want || got.Failing() != c.bad {
			t.Fatalf("Verdict(%v,%v) = %s failing=%v", c.x, c.fails, got, got.Failing())
		}
		if got == OutcomeXPass && !strings.Contains(msg, "remove its xfail tag") {
			t.Fatalf("XPASS message = %q", msg)
		}
	}
}

func TestXFailTagRequiresReasonIssuePartAndDrivers(t *testing.T) {
	ok := XFail{Part: "all", Reason: "later", Issue: "#651", Drivers: []string{"all"}}
	bad := map[string]func(*XFail){
		"no reason":    func(x *XFail) { x.Reason = "" },
		"no issue":     func(x *XFail) { x.Issue = "" },
		"not an issue": func(x *XFail) { x.Issue = "S2" },
		"no part":      func(x *XFail) { x.Part = "" },
		"no drivers":   func(x *XFail) { x.Drivers = nil },
		"bad driver":   func(x *XFail) { x.Drivers = []string{"k8s"} },
	}
	for name, mut := range bad {
		x := ok
		mut(&x)
		b := Block{Drivers: []string{"compose"}, XFail: []XFail{x}}
		if err := b.Validate(true); err == nil {
			t.Fatalf("%s: want error", name)
		}
	}
	if err := (Block{Drivers: []string{"compose"}, XFail: []XFail{ok}}).Validate(true); err != nil {
		t.Fatal(err)
	}
	ok.Issue = "#650 E3.1/E3.3"
	if err := (Block{Drivers: []string{"compose"}, XFail: []XFail{ok}}).Validate(true); err != nil {
		t.Fatalf("issue with suffix: %v", err)
	}
}

func TestSchemaRejectsUnknownKeys(t *testing.T) {
	for name, src := range map[string]string{
		"top":    "id: x\ndrivers: [compose]\nbogus: 1\n",
		"case":   "id: x\ndrivers: [compose]\ncases: [{name: a, bogus: 1}]\n",
		"target": "id: x\ndrivers: [compose]\ntarget: {run: {bogus: 1}}\n",
		"step":   "id: x\ndrivers: [compose]\nsteps: {a: {bogus: 1}}\n",
	} {
		if _, err := DecodeExpect([]byte(src)); err == nil {
			t.Fatalf("%s: unknown key accepted", name)
		}
	}
	src := "id: x\ndrivers: [compose]\ncases:\n  - name: a\n    patch: {\"spec.nodes[0].with.value.env\": prod}\n    today: {publish: {status: 400}}\n    target: {run: {status: [succeededWithErrors]}}\n    xfail: [{part: a, reason: r, issue: \"#649\", drivers: [all]}]\n"
	b, err := DecodeExpect([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	parts := Parts(b)
	if len(parts) != 1 || parts[0].XFail == nil || !parts[0].Block.Target.Run.Status.Has("succeededWithErrors") {
		t.Fatalf("parts = %+v", parts)
	}
}

func TestPartsMatchXFailByPartAndDriver(t *testing.T) {
	b := Block{Drivers: []string{"compose", "runner"}, Cases: []Block{{Name: "a"}, {Name: "b"}},
		XFail: []XFail{{Part: "b", Reason: "r", Issue: "#1", Drivers: []string{"runner"}}}}
	got := map[string]bool{}
	for _, p := range Parts(b) {
		got[p.Name+"/"+p.Driver] = p.XFail != nil
	}
	want := map[string]bool{"a/compose": false, "a/runner": false, "b/compose": false, "b/runner": true}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s xfail = %v, want %v (%v)", k, got[k], v, got)
		}
	}
}

func TestApplyPatch(t *testing.T) {
	src := "spec:\n  nodes:\n    - id: seed\n      with: {value: {env: staging}}\n  edges:\n    - {from: a.error, to: b.input}\n    - {from: a.result, to: c.input}\n"
	out, err := ApplyPatch(src, Patch{"spec.nodes[0].with.value.env": "prod", "drop-edge": "a.error"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "env: prod") || strings.Contains(out, "a.error") || !strings.Contains(out, "a.result") {
		t.Fatalf("patched = %s", out)
	}
	if _, err := ApplyPatch(src, Patch{"spec.nodes[3].id": "x"}); err == nil {
		t.Fatal("out-of-range index accepted")
	}
}

func TestLintRejectsXFailPartMatchingNoCase(t *testing.T) {
	bad := map[string]string{
		"top part names no case": "id: x\ndrivers: [compose]\ncases: [{name: a}]\nxfail: [{part: b, reason: r, issue: \"#1\", drivers: [all]}]\n",
		"no cases, part not all": "id: x\ndrivers: [compose]\nxfail: [{part: import+export, reason: r, issue: \"#1\", drivers: [all]}]\n",
		"case tag names another": "id: x\ndrivers: [compose]\ncases: [{name: a, xfail: [{part: b, reason: r, issue: \"#1\", drivers: [all]}]}, {name: b}]\n",
	}
	for name, src := range bad {
		if _, err := DecodeExpect([]byte(src)); err == nil || !strings.Contains(err.Error(), "part") {
			t.Fatalf("%s: err = %v, want part lint error", name, err)
		}
	}
	good := "id: x\ndrivers: [compose]\ncases: [{name: a, xfail: [{part: a, reason: r, issue: \"#1\", drivers: [all]}]}]\nxfail: [{part: all, reason: r, issue: \"#1\", drivers: [runner]}]\n"
	if _, err := DecodeExpect([]byte(good)); err != nil {
		t.Fatal(err)
	}
}

func TestActionsAndBuildParse(t *testing.T) {
	src := "id: x\ndrivers: [runner]\nbuild: fftest\nactions: [start, drive-until-waiting, kill-runner, {advance-clock: 3s}, new-runner, {set-now: +3s}, tick-recover, retry, drive]\n"
	b, err := DecodeExpect([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Actions) != 9 || b.Actions[3].Verb != "advance-clock" || b.Actions[3].Arg != "3s" || b.Build != buildFFTest {
		t.Fatalf("decoded %+v", b)
	}
	if d, _ := b.Actions[5].duration(); d.Seconds() != 3 {
		t.Fatalf("set-now duration = %v", d)
	}
	for name, src := range map[string]string{
		"unknown verb":  "id: x\ndrivers: [runner]\nactions: [teleport]\n",
		"missing arg":   "id: x\ndrivers: [runner]\nactions: [advance-clock]\n",
		"bad duration":  "id: x\ndrivers: [runner]\nactions: [{advance-clock: soon}]\n",
		"unknown build": "id: x\ndrivers: [runner]\nbuild: debug\n",
		"unknown key":   "id: x\ndrivers: [runner]\nmidRun: {bogus: 1}\n",
		"step error":    "id: x\ndrivers: [runner]\nsteps: {a: {error: {code: c, bogus: 1}}}\n",
	} {
		if _, err := DecodeExpect([]byte(src)); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	if _, err := DecodeExpect([]byte("id: x\ndrivers: [runner]\nactions: [start, {publish-v2: v2.workflow.yaml}, drive, retry-refused]\nerrorWorkflowFires: false\nsteps: {a: {errorHandling: none, input: {}}}\n")); err != nil {
		t.Fatalf("publish-v2/retry-refused: %v", err)
	}
	if _, err := DecodeExpect([]byte("id: x\ndrivers: [runner]\nactions: [publish-v2]\n")); err == nil {
		t.Fatal("publish-v2 without a file accepted")
	}
	if buildRuns(buildFFTest) != fftestBuild || buildRuns(buildDefault) == fftestBuild || !buildRuns("") {
		t.Fatal("buildRuns gating")
	}
}

func TestEvaluatedKeysAreNotPending(t *testing.T) {
	n := 0
	b := Block{
		Actions: []Action{{Verb: "start"}}, HTTP: &HTTPChecks{Retry: 201}, Jobs: map[string]JobExpect{"a": {Count: &n}},
		MidRun: &MidRun{}, PublishGuards: []PublishGuard{{}}, ExecutionsDelta: &n, NoStepStatusIn: []string{"pending"},
		AuditDetails: map[string]map[string]any{"job.resume": {"outcome": "result"}},
		Steps:        map[string]StepExpect{"a": {Attempts: 2, AttemptStatuses: []string{"failed"}, Port: "x", Error: &StepError{Code: "c"}, AttemptErrors: []StepError{{Code: "c"}}, SkipReason: "upstream_failed"}},
	}
	if p := b.pendingKeys(); len(p) != 0 {
		t.Fatalf("pending = %v", p)
	}
	if p := (Block{Steps: map[string]StepExpect{"a": {ItemCount: 3}}}).pendingKeys(); len(p) != 1 {
		t.Fatalf("itemCount should stay pending: %v", p)
	}
}

// Terry's M1: a harness gap is never a product failure.
func TestHarnessPendingNeverSatisfiesXFail(t *testing.T) {
	x := &XFail{Part: "all", Reason: "later", Issue: "#650", Drivers: []string{"all"}}
	pend := []string{"steps.a (extended keys)"}
	cases := []struct {
		x     *XFail
		fails []string
		want  Outcome
	}{
		{x, nil, OutcomePending},             // xfail resting on the gap alone
		{x, []string{"boom"}, OutcomeXFail},  // real product failure too
		{nil, nil, OutcomeFail},              // pass with unchecked keys
		{nil, []string{"boom"}, OutcomeFail}, // plain fail
	}
	for _, c := range cases {
		got, _ := VerdictPending("f", "compose", c.x, c.fails, pend)
		if got != c.want {
			t.Fatalf("VerdictPending(%v,%v) = %s, want %s", c.x != nil, c.fails, got, c.want)
		}
		if got.Failing() != (c.want != OutcomeXFail) {
			t.Fatalf("%s failing = %v", got, got.Failing())
		}
	}
	if got, _ := VerdictPending("f", "compose", x, []string{"boom"}, nil); got != OutcomeXFail {
		t.Fatalf("no pending: %s", got)
	}
}
