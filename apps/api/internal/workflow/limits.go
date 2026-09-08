package workflow

// Safe parser bounds. These sit below the HTTP 1 MiB body cap so a well-formed
// but hostile document still fails closed before graph validation.
const (
	MaxDocumentBytes = 256 << 10
	MaxYAMLNodes     = 4096
	MaxDepth         = 32
	MaxScalarBytes   = 64 << 10
	MaxTriggers      = 16
	MaxWorkflowNodes = 128
	MaxEdges         = 256
	MaxOutputs       = 32
	MaxLabels        = 32
	MaxWithKeys      = 64

	// Core neutral node contract bounds (E3.3). These sit well below the
	// document cap so a single node cannot dominate parse or later execution.
	MaxPortBytes        = 16 << 10
	MaxWithValueBytes   = 16 << 10
	MaxAggregationItems = 32
	MaxSchemaProperties = 32
	MaxSchemaDepth      = 8
	MaxFieldPathDepth   = 8
	MaxDelaySeconds     = 7 * 24 * 60 * 60
	MaxSafeMessageBytes = 256
	MaxMappingEntries   = 32
	MaxObjectFields     = 32
)
