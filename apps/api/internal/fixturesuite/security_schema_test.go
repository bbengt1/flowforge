package fixturesuite

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// S3 (#651) security specs: security/<id>.yaml. One spec is a list of
// checks; each check names a kind the harness implements. The schema is
// strict: unknown keys are rejected at decode, and a key a kind does not
// evaluate fails lint (secKindKeys), so no expectation is silently
// unchecked. xfail tags use the fixture rules (part = check name or all).
const securityDir = "security"

// SecuritySpec is one security/<id>.yaml.
type SecuritySpec struct {
	ID          string     `yaml:"id"`
	Description string     `yaml:"description"`
	Source      string     `yaml:"source"` // Terry's draft it implements
	Drivers     []string   `yaml:"drivers"`
	Checks      []SecCheck `yaml:"checks"`
	XFail       []XFail    `yaml:"xfail"`
}

// SecCheck is one security check. Which keys apply depends on Kind.
type SecCheck struct {
	Name string `yaml:"name"`
	Kind string `yaml:"kind"`
	Note string `yaml:"note"`

	// http / csrf
	As          string         `yaml:"as"` // owner editor viewer operator approver requester machine none B.owner
	Method      string         `yaml:"method"`
	Path        string         `yaml:"path"`
	Body        any            `yaml:"body"`
	Status      int            `yaml:"status"`
	Code        string         `yaml:"code"`
	NeverStatus []int          `yaml:"neverStatus"`
	SideEffects map[string]int `yaml:"sideEffects"`
	Session     string         `yaml:"session"` // csrf: no-header | bad-token | valid

	// sql-rows
	Tables []string `yaml:"tables"`
	Rows   *int     `yaml:"rows"`

	// audit
	Scenario              string                    `yaml:"scenario"`
	Audit                 map[string]int            `yaml:"audit"`
	AuditDetails          map[string]map[string]any `yaml:"auditDetails"`
	DetailsKeys           map[string][]string       `yaml:"detailsKeys"`
	DetailsMustNotContain map[string][]string       `yaml:"detailsMustNotContain"`
	// DetailsScopeKeys are required keys besides detailsKeys that must
	// equal the run/workflow's own tenant or workspace id (tenantId,
	// workspaceId). Missing or foreign values fail (S4 L1).
	DetailsScopeKeys    map[string][]string `yaml:"detailsScopeKeys"`
	NoActionPrefix      []string            `yaml:"noActionPrefix"`
	ApprovalEvents      *int                `yaml:"approvalEvents"`
	SkippedNodeJobAudit map[string]int      `yaml:"skippedNodeJobAudit"` // node -> job.* audit rows

	// canary-scan
	Canaries []string `yaml:"canaries"`
	Scan     []string `yaml:"scan"`  // api, db
	Forms    []string `yaml:"forms"` // substring, base64, urlencoded
	Hits     *int     `yaml:"hits"`

	// guard (save/publish refusal of a patched fixture)
	Fixture string        `yaml:"fixture"`
	Patch   Patch         `yaml:"patch"`
	Errors  []ErrorExpect `yaml:"errors"`

	// start-refused / version
	ExecutionsDelta *int   `yaml:"executionsDelta"`
	WorkflowsDelta  *int   `yaml:"workflowsDelta"`
	EditedFixture   string `yaml:"editedFixture"`
	StepsMatch      string `yaml:"stepsMatch"`
}

// secKindKeys lists, per kind, the keys it evaluates (besides name, kind,
// note). Any other set key fails lint.
var secKindKeys = map[string][]string{
	"http":         {"as", "method", "path", "body", "status", "code", "neverStatus", "sideEffects"},
	"csrf":         {"as", "method", "path", "body", "status", "code", "session", "sideEffects"},
	"sql-rows":     {"as", "tables", "rows"},
	"audit":        {"scenario", "audit", "auditDetails", "detailsKeys", "detailsMustNotContain", "detailsScopeKeys", "noActionPrefix", "approvalEvents", "skippedNodeJobAudit"},
	"canary-scan":  {"canaries", "scan", "forms", "hits"},
	"guard":        {"fixture", "patch", "status", "code", "errors", "workflowsDelta"},
	"start":        {"as", "body", "status", "code", "executionsDelta"},
	"version-pin":  {"fixture", "editedFixture", "stepsMatch"},
	"route-absent": {"as", "method", "path", "body", "status", "code"},
}

var secScenarios = map[string]bool{
	"linear": true, "retry": true, "decision": true, "override": true, "publish": true, "delete": true, "skipped": true,
}

var secRoles = map[string]bool{
	"owner": true, "editor": true, "viewer": true, "operator": true, "approver": true,
	"requester": true, "machine": true, "none": true, "B.owner": true,
}

// setKeys returns the yaml keys of c that are set.
func (c SecCheck) setKeys() []string {
	var out []string
	add := func(on bool, k string) {
		if on {
			out = append(out, k)
		}
	}
	add(c.As != "", "as")
	add(c.Method != "", "method")
	add(c.Path != "", "path")
	add(c.Body != nil, "body")
	add(c.Status != 0, "status")
	add(c.Code != "", "code")
	add(len(c.NeverStatus) > 0, "neverStatus")
	add(c.SideEffects != nil, "sideEffects")
	add(c.Session != "", "session")
	add(len(c.Tables) > 0, "tables")
	add(c.Rows != nil, "rows")
	add(c.Scenario != "", "scenario")
	add(c.Audit != nil, "audit")
	add(c.AuditDetails != nil, "auditDetails")
	add(c.DetailsKeys != nil, "detailsKeys")
	add(c.DetailsMustNotContain != nil, "detailsMustNotContain")
	add(c.DetailsScopeKeys != nil, "detailsScopeKeys")
	add(len(c.NoActionPrefix) > 0, "noActionPrefix")
	add(c.ApprovalEvents != nil, "approvalEvents")
	add(c.SkippedNodeJobAudit != nil, "skippedNodeJobAudit")
	add(len(c.Canaries) > 0, "canaries")
	add(len(c.Scan) > 0, "scan")
	add(len(c.Forms) > 0, "forms")
	add(c.Hits != nil, "hits")
	add(c.Fixture != "", "fixture")
	add(c.Patch != nil, "patch")
	add(len(c.Errors) > 0, "errors")
	add(c.ExecutionsDelta != nil, "executionsDelta")
	add(c.WorkflowsDelta != nil, "workflowsDelta")
	add(c.EditedFixture != "", "editedFixture")
	add(c.StepsMatch != "", "stepsMatch")
	return out
}

// Validate enforces structure, the per-kind key rule and xfail tags.
func (s SecuritySpec) Validate() error {
	if s.ID == "" {
		return fmt.Errorf("id is required")
	}
	if len(s.Drivers) == 0 {
		return fmt.Errorf("drivers: at least one driver is required")
	}
	if err := (Block{Drivers: s.Drivers, XFail: s.XFail}).Validate(true); err != nil {
		return err
	}
	names := map[string]bool{}
	for i, c := range s.Checks {
		if c.Name == "" || names[c.Name] {
			return fmt.Errorf("checks[%d]: name is required and unique (%q)", i, c.Name)
		}
		names[c.Name] = true
		allowed, ok := secKindKeys[c.Kind]
		if !ok {
			return fmt.Errorf("checks[%d] %s: unknown kind %q (known: %v)", i, c.Name, c.Kind, sortedKeys(boolSet(keysOf(secKindKeys))))
		}
		set := boolSet(allowed)
		for _, k := range c.setKeys() {
			if !set[k] {
				return fmt.Errorf("checks[%d] %s: kind %s does not evaluate %q (unchecked keys fail)", i, c.Name, c.Kind, k)
			}
		}
		if c.As != "" && !secRoles[c.As] {
			return fmt.Errorf("checks[%d] %s: unknown principal %q", i, c.Name, c.As)
		}
		if c.Kind == "audit" && !secScenarios[c.Scenario] {
			return fmt.Errorf("checks[%d] %s: unknown scenario %q", i, c.Name, c.Scenario)
		}
		if c.Kind == "csrf" && c.Session != "no-header" && c.Session != "bad-token" && c.Session != "valid" {
			return fmt.Errorf("checks[%d] %s: session must be no-header, bad-token or valid", i, c.Name)
		}
		if (c.Kind == "http" || c.Kind == "csrf" || c.Kind == "route-absent") && (c.Method == "" || !strings.HasPrefix(c.Path, "/api/v1/") || c.Status == 0) {
			return fmt.Errorf("checks[%d] %s: method, /api/v1/ path and status are required", i, c.Name)
		}
		for _, f := range c.Forms {
			if f != "substring" && f != "base64" && f != "urlencoded" {
				return fmt.Errorf("checks[%d] %s: unknown form %q", i, c.Name, f)
			}
		}
		for _, sc := range c.Scan {
			if sc != "api" && sc != "db" {
				return fmt.Errorf("checks[%d] %s: unknown scan target %q (api, db)", i, c.Name, sc)
			}
		}
	}
	for i, x := range s.XFail {
		if x.Part != "all" && !names[x.Part] {
			return fmt.Errorf("xfail[%d]: part %q names no check", i, x.Part)
		}
	}
	return nil
}

func keysOf(m map[string][]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func boolSet(list []string) map[string]bool {
	m := map[string]bool{}
	for _, k := range list {
		m[k] = true
	}
	return m
}

// DecodeSecuritySpec parses a spec strictly.
func DecodeSecuritySpec(raw []byte) (SecuritySpec, error) {
	var s SecuritySpec
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&s); err != nil {
		return s, err
	}
	return s, s.Validate()
}

// LoadSecuritySpecs reads every security/*.yaml.
func LoadSecuritySpecs(dir string) ([]SecuritySpec, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var out []SecuritySpec
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		s, err := DecodeSecuritySpec(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if want := strings.TrimSuffix(filepath.Base(f), ".yaml"); s.ID != want {
			return nil, fmt.Errorf("%s: id %q must match the file name", f, s.ID)
		}
		out = append(out, s)
	}
	return out, nil
}

// xfailFor returns the tag that applies to check name on driver.
func (s SecuritySpec) xfailFor(name, driver string) *XFail {
	for i := range s.XFail {
		x := s.XFail[i]
		if (x.Part == "all" || x.Part == name) && driverMatch(x.Drivers, driver) {
			return &x
		}
	}
	return nil
}
