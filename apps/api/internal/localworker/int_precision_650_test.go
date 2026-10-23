package localworker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #650 E3.3 QA M1: the claim response is decoded without rounding a whole
// number outside ±2^53 (step with, step output and inputs), and Complete
// sends it back exactly.
func TestClaimKeepsBigIntsExact650(t *testing.T) {
	var completeBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/jobs/claim":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"claimed": true, "jobToken": "t",
				"job": {"id": "11111111-1111-4111-8111-111111111111", "fencingToken": 1},
				"step": {"id": "33333333-3333-4333-8333-333333333333", "nodeId": "seed", "nodeType": "data.set",
					"input": {"value": {"big": 9007199254740993, "small": 5}},
					"output": {"prev": -9007199254740993}},
				"inputs": {"input": {"big": 9007199254740993, "f": 1.5, "small": 5}}}`)
		case strings.HasSuffix(r.URL.Path, "/complete"):
			raw, _ := io.ReadAll(r.Body)
			completeBody = string(raw)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	client := NewHTTP(HTTPConfig{BaseURL: srv.URL, Issuer: "https://idp.example", Subject: "worker-1", WorkerID: "worker-1"})
	claim, err := client.Claim(context.Background(), "tenant", "bench")
	if err != nil || claim == nil {
		t.Fatalf("claim %v %v", claim, err)
	}
	in := claim.Inputs["input"].(map[string]any)
	if in["big"] != json.Number("9007199254740993") || in["small"] != float64(5) || in["f"] != 1.5 {
		t.Fatalf("inputs %#v", in)
	}
	if v := claim.Step.Input["value"].(map[string]any); v["big"] != json.Number("9007199254740993") || v["small"] != float64(5) {
		t.Fatalf("step input %#v", v)
	}
	if claim.Step.Output["prev"] != json.Number("-9007199254740993") {
		t.Fatalf("step output %#v", claim.Step.Output)
	}
	if claim.Step.NodeID != "seed" || claim.Job.FencingToken != 1 {
		t.Fatalf("claim fields %+v", claim.Step)
	}
	if err := client.Complete(context.Background(), "tenant", "bench", *claim, map[string]any{"result": claim.Step.Input["value"]}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(completeBody, "9007199254740993") {
		t.Fatalf("complete body rounded: %s", completeBody)
	}
}
