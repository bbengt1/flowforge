package kubernetes

import (
	"strings"
	"testing"
)

func TestParseDocumentsTable(t *testing.T) {
	cases := []struct {
		name   string
		src    string
		want   int
		code   string
		kind   string
		wantNS string
	}{
		{
			name: "configmap",
			src:  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: cp-ops-nprd\ndata:\n  a: b\n",
			want: 1, kind: "ConfigMap", wantNS: "cp-ops-nprd",
		},
		{
			name: "multi-doc skips empty",
			src:  "---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: svc\n",
			want: 2,
		},
		{
			name: "missing name",
			src:  "apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n",
			code: CodeInvalidManifest,
		},
		{
			name: "not a mapping",
			src:  "- just a list\n",
			code: CodeInvalidManifest,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			docs, err := ParseDocuments(tc.src)
			if tc.code != "" {
				if err == nil || err.Code != tc.code {
					t.Fatalf("err = %+v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %+v", err)
			}
			if len(docs) != tc.want {
				t.Fatalf("len = %d want %d", len(docs), tc.want)
			}
			if tc.kind != "" && docs[0].Kind != tc.kind {
				t.Fatalf("kind = %s", docs[0].Kind)
			}
			if tc.wantNS != "" && docs[0].Namespace != tc.wantNS {
				t.Fatalf("ns = %s", docs[0].Namespace)
			}
			if !strings.HasPrefix(ManifestDigest(docs), "sha256:") {
				t.Fatal("digest")
			}
		})
	}
}
