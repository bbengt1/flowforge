package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.3: the typecheck route on real core nodes. A presence test
// (has) reports expression-parse with the 'k' in m hint and never echoes
// the source or field names (Terry's E3.2 smoke).
func TestDraftTypecheckCoreNodesPresenceHint650(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: FFX Core Presence
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          total: 5
    - id: gate
      type: flow.condition
      name: Gate
      with:
        expr: {expr: 'has(item.zqSecretField)'}
  edges:
    - from: constants.result
      to: gate.value
`
	created := createWorkflow(t, h, admin, tenant, ws, src)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceRequest(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/draft/typecheck", nil, admin, tenant, ws))
	if rec.Code != http.StatusOK {
		t.Fatalf("typecheck = %d %s", rec.Code, rec.Body.String())
	}
	var b typecheckBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if b.OK || len(b.Errors) != 1 || b.Errors[0].Code != workflow.CodeExpressionParse || b.Errors[0].NodeID != "gate" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if !strings.Contains(b.Errors[0].Message, "'k' in m") {
		t.Fatalf("no hint: %s", b.Errors[0].Message)
	}
	if strings.Contains(rec.Body.String(), "zqSecretField") || strings.Contains(rec.Body.String(), "has(") {
		t.Fatalf("echoed: %s", rec.Body.String())
	}
}
