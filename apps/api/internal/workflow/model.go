package workflow

// APIVersionV1 is the only supported document version.
const APIVersionV1 = "flowforge/v1"

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
}

// TriggerType describes an allowlisted trigger.
type TriggerType struct {
	Type    string `json:"type"`
	Phase   string `json:"phase"`
	Outputs []Port `json:"outputs"`
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
	APIVersion string        `json:"apiVersion"`
	Rules      CatalogRules  `json:"rules"`
	Triggers   []TriggerType `json:"triggers"`
	Nodes      []NodeType    `json:"nodes"`
}

// Document is the typed workflow graph after safe parse.
type Document struct {
	APIVersion string
	Kind       string
	Metadata   Metadata
	Spec       Spec
	pos        positions
}

// Metadata is the workflow-local identifier and labels.
type Metadata struct {
	Name   string
	Labels map[string]string
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
	return s
}
