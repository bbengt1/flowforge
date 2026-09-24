package workflowhttp

import (
	"strings"
	"testing"
)

func TestWorkflowExportFilenameSanitizesHeaderBreakers(t *testing.T) {
	got := workflowExportFilename(`Deploy "API"; ../evil\name`, 3)
	if strings.ContainsAny(got, "\";/\\") {
		t.Fatalf("filename still has header or path characters: %q", got)
	}
	if strings.Contains(got, "\n") || strings.Contains(got, "\r") {
		t.Fatalf("filename contains a newline: %q", got)
	}
	if !strings.HasSuffix(got, ".v3.yaml") {
		t.Fatalf("filename = %q", got)
	}
	if got := workflowExportFilename("   ", 1); got != "workflow.v1.yaml" {
		t.Fatalf("empty name = %q", got)
	}
	if got := workflowExportFilename("Deploy API", 2); got != "Deploy API.v2.yaml" {
		t.Fatalf("plain title = %q", got)
	}
}
