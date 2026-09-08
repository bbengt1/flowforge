package migrations

import "embed"

// SQL is the forward-only migration set applied by the API harness.
//
//go:embed *.sql
var SQL embed.FS
