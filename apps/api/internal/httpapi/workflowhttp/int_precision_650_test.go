package workflowhttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
)

// #650 E3.3 QA M1: a worker's job output is decoded without rounding a
// whole number outside ±2^53; every other number stays a float64.
func TestJobActionOutputKeepsBigIntsExact650(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/jobs/x/complete", strings.NewReader(`{"jobToken": "t", "output": {"result": {"big": 9007199254740993, "small": 5}}}`))
	r.Header.Set("Content-Type", "application/json")
	var req jobActionRequest
	if !core.DecodeJSON(httptest.NewRecorder(), r, &req) {
		t.Fatal("decode")
	}
	res := req.Output["result"].(map[string]any)
	if res["big"] != json.Number("9007199254740993") || res["small"] != float64(5) {
		t.Fatalf("%#v", res)
	}
	var out map[string]any = req.Output
	if raw, _ := json.Marshal(out); !strings.Contains(string(raw), "9007199254740993") {
		t.Fatalf("%s", raw)
	}
}
