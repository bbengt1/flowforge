package fixturesuite

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// StringSet is a scalar or a list of strings. Run and step statuses are
// sets so new terminal statuses (#649 succeededWithErrors) need no
// harness change.
type StringSet []string

func (s *StringSet) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		*s = StringSet{n.Value}
		return nil
	case yaml.SequenceNode:
		var out []string
		if err := n.Decode(&out); err != nil {
			return err
		}
		*s = out
		return nil
	}
	return fmt.Errorf("line %d: want a string or a list of strings", n.Line)
}

func (s StringSet) Has(v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// HTTPExpect is an expected HTTP answer (status + code, never text).
type HTTPExpect struct {
	Status int           `yaml:"status"`
	Code   string        `yaml:"code"`
	Errors []ErrorExpect `yaml:"errors"`
	Note   string        `yaml:"note"`
}

// ErrorExpect is one errors[] entry of a problem document.
type ErrorExpect struct {
	Path string `yaml:"path"`
	Code string `yaml:"code"`
}

// RunExpect is the run-level expectation.
type RunExpect struct {
	Status       StringSet `yaml:"status"`
	StatusReason *string   `yaml:"statusReason"`
	Outcome      string    `yaml:"outcome"` // not evaluated yet
	// Steps is a short form: node -> status set.
	Steps map[string]StringSet `yaml:"steps"`
}

// StepExpect is one node's expectation. Keys after Output are accepted for
// Terry's later fixtures but not evaluated yet (see pendingKeys).
type StepExpect struct {
	Status          StringSet      `yaml:"status"`
	Attempt         int            `yaml:"attempt"`
	Output          map[string]any `yaml:"output"`
	Attempts        int            `yaml:"attempts"`
	AttemptStatuses []string       `yaml:"attemptStatuses"`
	Input           map[string]any `yaml:"input"`
	Items           []any          `yaml:"items"`
	ItemCount       int            `yaml:"itemCount"`
	BodyRuns        int            `yaml:"bodyRuns"`
	Routed          string         `yaml:"routed"`
	Port            string         `yaml:"port"`
	JobCount        *int           `yaml:"jobCount"`
	DispatchedAfter []string       `yaml:"dispatchedAfter"`
	MinGapSeconds   int            `yaml:"minGapSeconds"`
}

// XFail marks a part of a fixture as expected to fail. Strict: a part that
// passes fails CI until the tag is removed.
type XFail struct {
	Part    string   `yaml:"part"`
	Reason  string   `yaml:"reason"`
	Issue   string   `yaml:"issue"`
	Drivers []string `yaml:"drivers"`
	Assert  string   `yaml:"assert"`
}

// Patch rewrites the workflow before publish: dotted paths in the same
// form as YAML refs ("spec.nodes[0].with.value.env": prod), plus
// "drop-edge": "<from port ref>".
type Patch map[string]any

// Block is the shared shape of the top level, a case, `today:` and
// `target:`. Unknown keys are rejected (KnownFields). Keys marked
// "accepted" are Terry's later-slice keys: they parse strictly but the S1
// harness does not evaluate them yet.
type Block struct {
	ID          string                `yaml:"id"`
	Name        string                `yaml:"name"`
	Description string                `yaml:"description"`
	Note        string                `yaml:"note"`
	Status      string                `yaml:"status"` // fixture label, e.g. partial
	File        string                `yaml:"file"`
	Drivers     []string              `yaml:"drivers"`
	Patch       Patch                 `yaml:"patch"`
	Publish     *HTTPExpect           `yaml:"publish"`
	Start       *HTTPExpect           `yaml:"start"`
	Run         *RunExpect            `yaml:"run"`
	Steps       map[string]StepExpect `yaml:"steps"`
	Audit       map[string]int        `yaml:"audit"`
	Cases       []Block               `yaml:"cases"`
	Today       *Block                `yaml:"today"`
	Target      *Block                `yaml:"target"`
	XFail       []XFail               `yaml:"xfail"`

	// accepted, not evaluated in S1
	Actions             []any             `yaml:"actions"`
	HTTP                map[string]any    `yaml:"http"`
	Jobs                map[string]any    `yaml:"jobs"`
	MidRun              any               `yaml:"midRun"`
	Expect              map[string]string `yaml:"expect"`
	Caps                any               `yaml:"caps"`
	PublishGuards       []any             `yaml:"publishGuards"`
	PayloadMaxBytes     int               `yaml:"payloadMaxBytes"`
	NoInputEcho         bool              `yaml:"noInputEcho"`
	ErrorWorkflowFires  *bool             `yaml:"errorWorkflowFires"`
	TestVersion         any               `yaml:"testVersion"`
	ProdPublish         any               `yaml:"prodPublish"`
	SecretInPin         any               `yaml:"secretInPin"`
	ResumeRoute         string            `yaml:"resumeRoute"`
	WrongToken          any               `yaml:"wrongToken"`
	WorkflowYamlPublish *HTTPExpect       `yaml:"workflowYamlPublish"`
	ImportRoute         *HTTPExpect       `yaml:"importRoute"`
	Import              any               `yaml:"import"`
	Export              any               `yaml:"export"`
	Unsupported         any               `yaml:"unsupported"`
}

// pendingKeys lists the accepted-but-unevaluated keys a block uses. A block
// the harness must pass (not xfail) with pending keys fails, so nothing is
// silently unchecked; an xfail part with pending keys stays XFAIL.
func (b Block) pendingKeys() []string {
	var out []string
	add := func(on bool, k string) {
		if on {
			out = append(out, k)
		}
	}
	add(len(b.Actions) > 0, "actions")
	add(len(b.HTTP) > 0, "http")
	add(len(b.Jobs) > 0, "jobs")
	add(b.MidRun != nil, "midRun")
	add(len(b.Expect) > 0, "expect")
	add(b.Caps != nil, "caps")
	add(len(b.PublishGuards) > 0, "publishGuards")
	add(b.PayloadMaxBytes > 0, "payloadMaxBytes")
	add(b.NoInputEcho, "noInputEcho")
	add(b.ErrorWorkflowFires != nil, "errorWorkflowFires")
	add(b.TestVersion != nil || b.ProdPublish != nil || b.SecretInPin != nil, "pinData checks")
	add(b.ResumeRoute != "" || b.WrongToken != nil, "resume route")
	add(b.WorkflowYamlPublish != nil || b.ImportRoute != nil || b.Import != nil || b.Export != nil || b.Unsupported != nil, "import/export")
	add(b.Run != nil && b.Run.Outcome != "", "run.outcome")
	for id, s := range b.Steps {
		add(s.Attempts != 0 || len(s.AttemptStatuses) > 0 || s.Input != nil || s.Items != nil || s.ItemCount != 0 ||
			s.BodyRuns != 0 || s.Routed != "" || s.Port != "" || s.JobCount != nil || len(s.DispatchedAfter) > 0 || s.MinGapSeconds != 0,
			"steps."+id+" (extended keys)")
	}
	sort.Strings(out)
	return out
}

// Fixture is one fixtures/<id>/ directory.
type Fixture struct {
	ID     string
	Dir    string
	Expect Block
}

var issueRef = regexp.MustCompile(`^#[0-9]+\b`)

var knownDrivers = map[string]bool{"compose": true, "runner": true}

// Validate enforces structure and the strict-xfail tag rules.
func (b Block) Validate(top bool) error {
	if top {
		if len(b.Drivers) == 0 {
			return fmt.Errorf("drivers: at least one driver is required")
		}
	}
	for _, d := range b.Drivers {
		if !knownDrivers[d] {
			return fmt.Errorf("drivers: unknown driver %q", d)
		}
	}
	for i, x := range b.XFail {
		if strings.TrimSpace(x.Reason) == "" {
			return fmt.Errorf("xfail[%d]: reason is required", i)
		}
		if !issueRef.MatchString(strings.TrimSpace(x.Issue)) {
			return fmt.Errorf("xfail[%d]: issue must start with an issue ref like #651, got %q", i, x.Issue)
		}
		if strings.TrimSpace(x.Part) == "" {
			return fmt.Errorf("xfail[%d]: part is required (a case name or all)", i)
		}
		if len(x.Drivers) == 0 {
			return fmt.Errorf("xfail[%d]: drivers is required (driver names or all)", i)
		}
		for _, d := range x.Drivers {
			if d != "all" && !knownDrivers[d] {
				return fmt.Errorf("xfail[%d]: unknown driver %q", i, d)
			}
		}
	}
	for i, c := range b.Cases {
		if c.Name == "" {
			return fmt.Errorf("cases[%d]: name is required", i)
		}
		if err := c.Validate(false); err != nil {
			return fmt.Errorf("cases[%d] %s: %w", i, c.Name, err)
		}
	}
	for name, sub := range map[string]*Block{"today": b.Today, "target": b.Target} {
		if sub != nil {
			if err := sub.Validate(false); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		}
	}
	return nil
}

// DecodeExpect parses expect.yaml strictly.
func DecodeExpect(raw []byte) (Block, error) {
	var b Block
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&b); err != nil {
		return b, err
	}
	return b, b.Validate(true)
}

// LoadFixtures reads every fixtures/<id>/ directory with an expect.yaml.
// security/ (S3) is a separate shape and is not loaded here.
func LoadFixtures(root string) ([]Fixture, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []Fixture
	for _, ent := range entries {
		dir := filepath.Join(root, ent.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "expect.yaml"))
		if !ent.IsDir() || os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		b, err := DecodeExpect(raw)
		if err != nil {
			return nil, fmt.Errorf("%s/expect.yaml: %w", ent.Name(), err)
		}
		out = append(out, Fixture{ID: ent.Name(), Dir: dir, Expect: b})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
