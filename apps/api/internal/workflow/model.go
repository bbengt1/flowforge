package workflow

// APIVersionV1 is the only supported document version.
const APIVersionV1 = "flowforge/v1"

// UILayoutVersion is the only accepted metadata.ui.layout.version.
const UILayoutVersion = 1

// KindWorkflow is the only supported document kind.
const KindWorkflow = "Workflow"

// Phase values for catalog entries.
const (
	PhaseCore     = "core"
	PhaseNext     = "next"
	PhaseProvider = "provider"
)

// PortKind is a coarse compatibility type for node ports.
type PortKind string

const (
	PortObject  PortKind = "object"
	PortString  PortKind = "string"
	PortInteger PortKind = "integer"
	PortBoolean PortKind = "boolean"
	PortAny     PortKind = "any"
)

// Data classification labels. Secret is never a legal port payload.
const (
	ClassPublic       = "public"
	ClassInternal     = "internal"
	ClassConfidential = "confidential"
	ClassSecret       = "secret"
	ClassInherit      = "inherit"
)

// Port is a named typed input or output on a node.
type Port struct {
	Name           string   `json:"name"`
	Kind           PortKind `json:"kind"`
	Required       bool     `json:"required"`
	Classification string   `json:"classification,omitempty"`
	MaxBytes       int      `json:"maxBytes,omitempty"`
	Description    string   `json:"description,omitempty"`
}

// WithField is an allowlisted node configuration key.
type WithField struct {
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	Required    bool     `json:"required"`
	Enum        []string `json:"enum,omitempty"`
	Description string   `json:"description,omitempty"`
}

// NodePolicy is the publish-time permission and retry contract.
type NodePolicy struct {
	Permissions        []string `json:"permissions"`
	RetrySafe          bool     `json:"retrySafe"`
	SideEffects        bool     `json:"sideEffects"`
	Idempotent         bool     `json:"idempotent"`
	Cancellation       string   `json:"cancellation"`
	Verification       string   `json:"verification,omitempty"`
	DefaultMaxAttempts int      `json:"defaultMaxAttempts"`
}

// NodeBounds caps inputs, outputs, configuration, and aggregation.
type NodeBounds struct {
	MaxInputBytes       int `json:"maxInputBytes"`
	MaxOutputBytes      int `json:"maxOutputBytes"`
	MaxWithBytes        int `json:"maxWithBytes"`
	MaxAggregationItems int `json:"maxAggregationItems"`
	MaxDurationSeconds  int `json:"maxDurationSeconds,omitempty"`
}

// RedactionPolicy describes what a node may persist or audit.
type RedactionPolicy struct {
	AuditFields   []string `json:"auditFields"`
	RedactInputs  bool     `json:"redactInputs"`
	RedactOutputs bool     `json:"redactOutputs"`
	Strategy      string   `json:"strategy"`
}

// CatalogRules are stable authoring constraints for the UI.
type CatalogRules struct {
	TriggersAreWorkflowLevel  bool `json:"triggersAreWorkflowLevel"`
	GraphNodesExcludeTriggers bool `json:"graphNodesExcludeTriggers"`
	UnsupportedPhasesRejected bool `json:"unsupportedPhasesRejected"`
	IntegrationActionsEnabled bool `json:"integrationActionsEnabled"`
}

// IntegrationGate documents the E10.4 enablement check for Chloe.
type IntegrationGate struct {
	Name    string   `json:"name"`
	Enabled bool     `json:"enabled"`
	Nodes   []string `json:"nodes"`
	Suites  []string `json:"suites"`
	Note    string   `json:"note"`
}

// TriggerStart is the authenticated manual-start contract (E10.1).
type TriggerStart struct {
	Route                    string   `json:"route"`
	Method                   string   `json:"method"`
	Permission               string   `json:"permission"`
	CSRF                     bool     `json:"csrf"`
	PublishedVersionRequired bool     `json:"publishedVersionRequired"`
	VersionField             string   `json:"versionField"`
	InputField               string   `json:"inputField"`
	SchemaFields             []string `json:"schemaFields"`
	IdempotencyKeyField      string   `json:"idempotencyKeyField"`
	IdempotencyHeader        string   `json:"idempotencyHeader"`
	IdempotencyKeyRequired   bool     `json:"idempotencyKeyRequired"`
	IdempotencyKeyPattern    string   `json:"idempotencyKeyPattern"`
	MaxInputBytes            int      `json:"maxInputBytes"`
	CreatedStatus            int      `json:"createdStatus"`
	ReplayStatus             int      `json:"replayStatus"`
	ConflictStatus           int      `json:"conflictStatus"`
	PolicyDenyStatus         int      `json:"policyDenyStatus"`
	ApprovalRequiredStatus   int      `json:"approvalRequiredStatus"`
	DraftStatus              int      `json:"draftStatus"`
	Help                     string   `json:"help"`
}

// TriggerIngress is the public webhook delivery contract (E10.2).
type TriggerIngress struct {
	Route                  string   `json:"route"`
	Method                 string   `json:"method"`
	Public                 bool     `json:"public"`
	CSRF                   bool     `json:"csrf"`
	Session                bool     `json:"session"`
	SignatureHeader        string   `json:"signatureHeader"`
	TimestampHeader        string   `json:"timestampHeader"`
	SignatureVersion       string   `json:"signatureVersion"`
	IdempotencyHeader      string   `json:"idempotencyHeader"`
	MaxBodyBytes           int      `json:"maxBodyBytes"`
	MaxInputBytes          int      `json:"maxInputBytes"`
	ClockSkewSeconds       int      `json:"clockSkewSeconds"`
	ReplayRetentionSeconds int      `json:"replayRetentionSeconds"`
	DefaultRatePerMinute   int      `json:"defaultRatePerMinute"`
	DefaultWorkspaceRate   int      `json:"defaultWorkspaceRatePerMinute"`
	DefaultMaxConcurrency  int      `json:"defaultMaxConcurrency"`
	DefaultWorkspaceConc   int      `json:"defaultWorkspaceMaxConcurrency"`
	ContentTypes           []string `json:"contentTypes"`
	CreatedStatus          int      `json:"createdStatus"`
	ReplayStatus           int      `json:"replayStatus"`
	ConflictStatus         int      `json:"conflictStatus"`
	UnauthorizedStatus     int      `json:"unauthorizedStatus"`
	RateLimitedStatus      int      `json:"rateLimitedStatus"`
	TooLargeStatus         int      `json:"tooLargeStatus"`
	DisabledStatus         int      `json:"disabledStatus"`
	Help                   string   `json:"help"`
}

// TriggerAdmin is the cookie-session CRUD/rotate contract (E10.2).
type TriggerAdmin struct {
	ListRoute           string `json:"listRoute"`
	CreateRoute         string `json:"createRoute"`
	ItemRoute           string `json:"itemRoute"`
	RotateRoute         string `json:"rotateRoute"`
	DisableRoute        string `json:"disableRoute"`
	EnableRoute         string `json:"enableRoute"`
	DeleteRoute         string `json:"deleteRoute"`
	Permission          string `json:"permission"`
	ViewPermission      string `json:"viewPermission"`
	DispatchRoute       string `json:"dispatchRoute,omitempty"`
	DispatchPermission  string `json:"dispatchPermission,omitempty"`
	CSRF                bool   `json:"csrf"`
	SecretNeverReturned bool   `json:"secretNeverReturned"`
	Help                string `json:"help"`
}

// TriggerType describes an allowlisted trigger.
type TriggerType struct {
	Type        string           `json:"type"`
	Phase       string           `json:"phase"`
	Title       string           `json:"title,omitempty"`
	Description string           `json:"description,omitempty"`
	Outputs     []Port           `json:"outputs"`
	AllowedWith []WithField      `json:"allowedWith,omitempty"`
	Bounds      *NodeBounds      `json:"bounds,omitempty"`
	Redaction   *RedactionPolicy `json:"redaction,omitempty"`
	Start       *TriggerStart    `json:"start,omitempty"`
	Ingress     *TriggerIngress  `json:"ingress,omitempty"`
	Admin       *TriggerAdmin    `json:"admin,omitempty"`
}

// NodeType describes an allowlisted action node.
type NodeType struct {
	Type         string           `json:"type"`
	Phase        string           `json:"phase"`
	Title        string           `json:"title,omitempty"`
	Description  string           `json:"description,omitempty"`
	Inputs       []Port           `json:"inputs"`
	Outputs      []Port           `json:"outputs"`
	RequiredWith []string         `json:"requiredWith,omitempty"`
	AllowedWith  []WithField      `json:"allowedWith,omitempty"`
	Policy       *NodePolicy      `json:"policy,omitempty"`
	Bounds       *NodeBounds      `json:"bounds,omitempty"`
	Redaction    *RedactionPolicy `json:"redaction,omitempty"`
}

// Catalog is the typed graph vocabulary published to the UI.
type Catalog struct {
	APIVersion      string          `json:"apiVersion"`
	Rules           CatalogRules    `json:"rules"`
	IntegrationGate IntegrationGate `json:"integrationGate"`
	Triggers        []TriggerType   `json:"triggers"`
	Nodes           []NodeType      `json:"nodes"`
}

// Document is the typed workflow graph after safe parse.
type Document struct {
	APIVersion string
	Kind       string
	Metadata   Metadata
	Spec       Spec
	pos        positions
}

// Metadata is the workflow-local identifier, labels, and optional UI hints.
type Metadata struct {
	Name   string
	Labels map[string]string
	UI     *UIMetadata
}

// UIMetadata is additive optional canvas metadata. The executor, policy
// evaluate, port typing, and dispatch ignore it (D1 / #238).
type UIMetadata struct {
	Layout *UILayout
}

// UILayout is a non-authoritative node-position hint. Missing or invalid
// layout is treated as absent (auto-layout). It never carries edges, types,
// with, credentials, or ports, and never invents graph nodes.
type UILayout struct {
	Version int
	Nodes   map[string]UINodePosition
}

// UINodePosition is a finite canvas coordinate for one spec.nodes[].id.
type UINodePosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Spec is the typed graph.
type Spec struct {
	Description string
	Triggers    []Trigger
	Nodes       []Node
	Edges       []Edge
	Outputs     []Output
}

// Trigger is a workflow-level entry point (not a graph node).
type Trigger struct {
	ID   string
	Type string
	With map[string]any
	pos  loc
}

// Node is a typed action with ports.
type Node struct {
	ID     string
	Type   string
	Name   string
	With   map[string]any
	Inputs map[string]any
	pos    loc
}

// Edge connects an output port to a compatible input port.
type Edge struct {
	From string
	To   string
	pos  loc
}

// Output is a workflow-level named export from a node port.
type Output struct {
	Name string
	From string
	pos  loc
}

// PortRef is a parsed nodeId.port reference.
type PortRef struct {
	NodeID string
	Port   string
}

// Summary is a parsed-graph projection for the UI canvas.
type Summary struct {
	APIVersion  string           `json:"apiVersion"`
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Triggers    []TriggerSummary `json:"triggers"`
	Nodes       []NodeSummary    `json:"nodes"`
	Edges       []EdgeSummary    `json:"edges"`
	Outputs     []OutputSummary  `json:"outputs"`
	UI          *UISummary       `json:"ui,omitempty"`
}

// UISummary is the optional non-authoritative canvas hint projection.
type UISummary struct {
	Layout *UILayoutSummary `json:"layout,omitempty"`
}

// UILayoutSummary is returned on validate/normalize/draft/version so Chloe
// can read D1 positions without re-parsing YAML. Executor paths ignore it.
type UILayoutSummary struct {
	Version int                        `json:"version"`
	Nodes   map[string]UINodePosition  `json:"nodes,omitempty"`
}

// TriggerSummary is the catalog-facing trigger projection.
type TriggerSummary struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// NodeSummary is the catalog-facing node projection.
type NodeSummary struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Name string `json:"name"`
}

// EdgeSummary is the catalog-facing edge projection.
type EdgeSummary struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// OutputSummary is the catalog-facing output projection.
type OutputSummary struct {
	Name string `json:"name"`
	From string `json:"from"`
}

// Result is a successful parse/normalize outcome.
type Result struct {
	Document       *Document
	NormalizedYAML string
	Digest         string
	Summary        Summary
	Warnings       []FieldError
}

type loc struct {
	Line   int
	Column int
}

type positions struct {
	root     loc
	metadata loc
	spec     loc
	name     loc
}

func (d *Document) Summary() Summary {
	s := Summary{
		APIVersion:  d.APIVersion,
		Name:        d.Metadata.Name,
		Description: d.Spec.Description,
		Triggers:    make([]TriggerSummary, 0, len(d.Spec.Triggers)),
		Nodes:       make([]NodeSummary, 0, len(d.Spec.Nodes)),
		Edges:       make([]EdgeSummary, 0, len(d.Spec.Edges)),
		Outputs:     make([]OutputSummary, 0, len(d.Spec.Outputs)),
	}
	for _, t := range d.Spec.Triggers {
		s.Triggers = append(s.Triggers, TriggerSummary{ID: t.ID, Type: t.Type})
	}
	for _, n := range d.Spec.Nodes {
		s.Nodes = append(s.Nodes, NodeSummary{ID: n.ID, Type: n.Type, Name: n.Name})
	}
	for _, e := range d.Spec.Edges {
		s.Edges = append(s.Edges, EdgeSummary{From: e.From, To: e.To})
	}
	for _, o := range d.Spec.Outputs {
		s.Outputs = append(s.Outputs, OutputSummary{Name: o.Name, From: o.From})
	}
	if layout := d.UILayout(); layout != nil {
		nodes := map[string]UINodePosition{}
		for id, pos := range layout.Nodes {
			nodes[id] = pos
		}
		s.UI = &UISummary{Layout: &UILayoutSummary{Version: layout.Version, Nodes: nodes}}
		if len(nodes) == 0 {
			s.UI.Layout.Nodes = nil
		}
	}
	return s
}

// UILayout returns the normalized optional layout, or nil when absent.
func (d *Document) UILayout() *UILayout {
	if d == nil || d.Metadata.UI == nil {
		return nil
	}
	return d.Metadata.UI.Layout
}

// ExecutionGraph is the spec-only shape used by dispatch, policy, and port
// typing. metadata.ui is intentionally omitted.
type ExecutionGraph struct {
	Triggers []Trigger
	Nodes    []Node
	Edges    []Edge
	Outputs  []Output
}

// ExecutionGraph returns a deep-enough copy of spec triggers/nodes/edges/outputs
// for bitwise comparison. Layout is not included.
func (d *Document) ExecutionGraph() ExecutionGraph {
	if d == nil {
		return ExecutionGraph{}
	}
	g := ExecutionGraph{
		Triggers: append([]Trigger(nil), d.Spec.Triggers...),
		Nodes:    make([]Node, len(d.Spec.Nodes)),
		Edges:    append([]Edge(nil), d.Spec.Edges...),
		Outputs:  append([]Output(nil), d.Spec.Outputs...),
	}
	for i, n := range d.Spec.Nodes {
		g.Nodes[i] = Node{
			ID:     n.ID,
			Type:   n.Type,
			Name:   n.Name,
			With:   cloneAnyMap(n.With),
			Inputs: cloneAnyMap(n.Inputs),
		}
	}
	for i := range g.Triggers {
		g.Triggers[i].With = cloneAnyMap(d.Spec.Triggers[i].With)
		g.Triggers[i].pos = loc{}
	}
	for i := range g.Nodes {
		g.Nodes[i].pos = loc{}
	}
	for i := range g.Edges {
		g.Edges[i].pos = loc{}
	}
	for i := range g.Outputs {
		g.Outputs[i].pos = loc{}
	}
	return g
}
