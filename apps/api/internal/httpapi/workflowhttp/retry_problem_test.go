package workflowhttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestRetryConflictDoesNotUseSlugMessage(t *testing.T) {
	cases := []error{
		&wfstore.NotRetryableError{Reason: wfstore.ReasonRunCanceled},
		wfstore.ErrStepAttemptSuperseded,
		wfstore.ErrConstraint,
	}
	for _, err := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/executions/x/steps/y/retry", nil)
		WriteWorkflowStoreError(rec, req, err)
		if rec.Code != http.StatusConflict {
			t.Fatalf("%v status %d", err, rec.Code)
		}
		body := rec.Body.String()
		if strings.Contains(body, "slug already exists") {
			t.Fatalf("slug message for %v: %s", err, body)
		}
		var problem core.Problem
		if decErr := json.Unmarshal(rec.Body.Bytes(), &problem); decErr != nil {
			t.Fatal(decErr)
		}
		switch err {
		case wfstore.ErrStepAttemptSuperseded:
			if problem.Code != core.CodeStepAttemptSuperseded {
				t.Fatalf("code = %s", problem.Code)
			}
		case wfstore.ErrConstraint:
			if problem.Code != core.CodeConflict || problem.Detail == "" {
				t.Fatalf("constraint = %+v", problem)
			}
		default:
			if problem.Code != core.CodeExecutionNotRetryable || problem.Reason != wfstore.ReasonRunCanceled {
				t.Fatalf("not retryable = %+v", problem)
			}
		}
	}
}
