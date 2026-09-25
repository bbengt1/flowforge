package approvalhttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
)

func TestApprovalClosedProblem(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/approvals/x/decide", nil)
	WriteApprovalError(rec, req, approval.ErrClosed)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d", rec.Code)
	}
	var problem core.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if problem.Code != core.CodeApprovalClosed {
		t.Fatalf("code = %s body=%s", problem.Code, rec.Body.String())
	}
}
