package openapi

import "embed"

// FS holds the published OpenAPI document.
//
//go:embed openapi.yaml
var FS embed.FS
