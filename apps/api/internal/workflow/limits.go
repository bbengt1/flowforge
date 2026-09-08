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
)
