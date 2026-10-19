package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fieldPathInner struct {
	Count int `json:"count"`
}

type fieldPathReq struct {
	Name   string                    `json:"name"`
	Inner  fieldPathInner            `json:"inner"`
	Labels map[string]int            `json:"labels"`
	Nested map[string]fieldPathInner `json:"nested"`
}

func decodeProblem(t *testing.T, body string, dst any) (string, string) {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	if DecodeJSON(w, r, dst) {
		t.Fatalf("decode of %s succeeded", body)
	}
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	var p struct {
		Detail string `json:"detail"`
		Errors []struct {
			Path string `json:"path"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatalf("problem body: %v", err)
	}
	if len(p.Errors) != 1 {
		t.Fatalf("errors = %d, want 1: %s", len(p.Errors), w.Body.String())
	}
	return p.Errors[0].Path, p.Detail
}

func TestDecodeJSONFieldPathStopsAtMapKey(t *testing.T) {
	const secretKey = "client-chosen-key-xyz"
	cases := []struct {
		name, body, wantPath, wantDetail string
		dst                              any
	}{
		{"struct field", `{"inner":{"count":"a"}}`, "inner.count", "inner.count must be an integer.", &fieldPathReq{}},
		{"map value", `{"labels":{"` + secretKey + `":"a"}}`, "labels", "labels must be an object.", &fieldPathReq{}},
		{"map struct value", `{"nested":{"` + secretKey + `":{"count":"a"}}}`, "nested", "nested must be an object.", &fieldPathReq{}},
		{"top-level map", `{"` + secretKey + `":"a"}`, "body", "body must be an object.", &map[string]int{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path, detail := decodeProblem(t, tc.body, tc.dst)
			if path != tc.wantPath || detail != tc.wantDetail {
				t.Fatalf("path=%q detail=%q, want %q / %q", path, detail, tc.wantPath, tc.wantDetail)
			}
			if strings.Contains(path+detail, secretKey) {
				t.Fatalf("map key echoed: %q %q", path, detail)
			}
		})
	}
}
