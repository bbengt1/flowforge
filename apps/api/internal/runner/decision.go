package runner

import (
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Failure codes persisted on the job. They never include credential
// material or the compose local-worker sentence.
const (
	CodeUnsupported         = "runner-unsupported"
	CodeDraftNotRunnable    = "draft-not-runnable"
	CodeJobBindingRejected  = "job-binding-rejected"
	CodeUnpublishedPin      = "unpublished-pin"
	CodeHandleForbidden     = "handle-forbidden"
	CodeIntegrationDisabled = "integration-disabled"
)

// Decision is the production runner's action for one claimed job.
type Decision struct {
	Skip    bool
	Reason  string
	Fail    bool
	Output  map[string]any
	Error   map[string]any
	Message string
}

func fail(code, message string) Decision {
	return Decision{
		Fail:    true,
		Error:   map[string]any{"code": code, "message": message},
		Message: message,
	}
}

func classifyBinding(binding wfstore.JobBinding, err error) Decision {
	if err == nil {
		return Decision{}
	}
	if strings.TrimSpace(binding.WorkflowVersionID) == "" || strings.TrimSpace(binding.WorkflowDigest) == "" {
		return fail(CodeDraftNotRunnable, "Draft workflows never run.")
	}
	return fail(CodeJobBindingRejected, "Worker rejected the authenticated job binding.")
}
