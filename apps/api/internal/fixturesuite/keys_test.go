package fixturesuite

import (
	"fmt"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Build gating (#658). A part with build: fftest runs only in a binary
// built with -tags fftest (test.flaky exists); build: default runs only
// untagged (where test.flaky must be refused with unsupported-node).
const (
	buildFFTest  = "fftest"
	buildDefault = "default"
)

// buildRuns reports whether a part with this build gate runs in this
// test binary.
func buildRuns(build string) bool {
	switch build {
	case buildFFTest:
		return fftestBuild
	case buildDefault:
		return !fftestBuild
	}
	return true
}

// Action is one scripted step of a part: a bare verb ("drive") or a
// one-key map with an argument ("advance-clock: 3s").
type Action struct {
	Verb string
	Arg  string
}

func (a *Action) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		a.Verb = n.Value
		return nil
	case yaml.MappingNode:
		if len(n.Content) != 2 {
			return fmt.Errorf("line %d: an action map has exactly one key", n.Line)
		}
		a.Verb, a.Arg = n.Content[0].Value, n.Content[1].Value
		return nil
	}
	return fmt.Errorf("line %d: want an action name or {name: arg}", n.Line)
}

// Verbs:
//
//	start               POST /workflows/{id}/executions as owner
//	drive               the driver's full drive (runner: clock rounds + TickRecover)
//	drive-until-waiting one drain, no clock movement, then midRun is checked
//	retry               POST /executions/{id}/retry (RetryStep) as owner
//	kill-runner         drop the current worker; the next drive uses a new
//	new-runner          worker identity (must follow kill-runner)
//	advance-clock: D    move the fake clock forward by D
//	set-now: +D         same, written as an offset from now
//	tick-recover        run the API's lease/approval-expiry sweep once
//	retry-refused       POST /executions/{id}/retry as owner must answer 409
//	publish-v2: FILE    save FILE (same dir) as the draft and publish it as
//	                    the next version; the started run stays on v1
var actionArgs = map[string]bool{
	"start": false, "drive": false, "drive-until-waiting": false, "retry": false,
	"kill-runner": false, "new-runner": false, "tick-recover": false, "retry-refused": false,
	"advance-clock": true, "set-now": true, "publish-v2": true,
}

func (a Action) duration() (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimPrefix(strings.TrimSpace(a.Arg), "+"))
	if err == nil && d <= 0 {
		err = fmt.Errorf("must be positive")
	}
	return d, err
}

func (a Action) validate() error {
	needs, ok := actionArgs[a.Verb]
	if !ok {
		return fmt.Errorf("unknown action %q", a.Verb)
	}
	if needs != (a.Arg != "") {
		return fmt.Errorf("action %q: argument mismatch", a.Verb)
	}
	if needs && a.Verb != "publish-v2" {
		if _, err := a.duration(); err != nil {
			return fmt.Errorf("action %s: %q: %w", a.Verb, a.Arg, err)
		}
	}
	return nil
}

// HTTPChecks are answers to scripted actions.
type HTTPChecks struct {
	// Retry is the expected status of every `retry` action (default 201).
	Retry int `yaml:"retry"`
	// RetryAsViewer, when set, retries once as the viewer after the
	// actions and expects this answer with no side effect (audit counts
	// are read afterwards).
	RetryAsViewer *HTTPExpect `yaml:"retryAsViewer"`
}

// JobExpect counts execution_jobs rows for one node.
type JobExpect struct {
	Count *int `yaml:"count"`
}

// MidRun is checked right after the first drive-until-waiting.
type MidRun struct {
	Status StringSet             `yaml:"status"`
	Steps  map[string]StepExpect `yaml:"steps"`
}

// PublishGuard is one save/publish refusal: the patch is applied over the
// part's workflow and the create (or, if it saves, the publish) must answer
// status (default 400) and code when set.
type PublishGuard struct {
	Patch  Patch  `yaml:"patch"`
	Status int    `yaml:"status"`
	Code   string `yaml:"code"`
	// Errors are errors[] codes the answer must contain. Paths are not
	// asserted when empty (#666: publish paths index the stored draft).
	Errors []ErrorExpect `yaml:"errors"`
	Note   string        `yaml:"note"`
}

// StepError is a step's error document (code, message), never output.
type StepError struct {
	Code    string `yaml:"code"`
	Message string `yaml:"message"`
}

// RouteExpect is an HTTP answer for an explicit API path.
type RouteExpect struct {
	Path   string `yaml:"path"`
	Status int    `yaml:"status"`
	Code   string `yaml:"code"`
}
