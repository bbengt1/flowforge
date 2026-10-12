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
