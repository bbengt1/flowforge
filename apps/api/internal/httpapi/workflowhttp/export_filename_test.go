package workflowhttp

import (
	"mime"
	"strings"
	"testing"
	"unicode"
)

func TestWorkflowExportFilenameSanitizesHeaderBreakers(t *testing.T) {
	got := workflowExportFilename(`Deploy "API"; ../evil\name`, "ignored", 3)
	if strings.ContainsAny(got, "\";/\\") {
		t.Fatalf("filename still has header or path characters: %q", got)
	}
	if strings.Contains(got, "\n") || strings.Contains(got, "\r") {
		t.Fatalf("filename contains a newline: %q", got)
	}
	if !strings.HasSuffix(got, ".v3.yaml") {
		t.Fatalf("filename = %q", got)
	}
	if got := workflowExportFilename("   ", "", 1); got != "workflow.yaml" {
		t.Fatalf("empty name = %q", got)
	}
	if got := workflowExportFilename("   ", "deploy-api", 1); got != "deploy-api.v1.yaml" {
		t.Fatalf("slug fallback = %q", got)
	}
	if got := workflowExportFilename("Deploy API", "deploy-api", 2); got != "Deploy API.v2.yaml" {
		t.Fatalf("plain title = %q", got)
	}
}

func TestExportContentDisposition(t *testing.T) {
	cases := []struct {
		name     string
		title    string
		slug     string
		version  int
		filename string
		star     bool
	}{
		{name: "ascii", title: "Deploy API", slug: "deploy-api", version: 2, filename: "Deploy API.v2.yaml"},
		{name: "non-ascii", title: "部署流程", slug: "deploy-api", version: 1, filename: "deploy-api.v1.yaml", star: true},
		{name: "hostile", title: "a\r\n\"\\/..\u202e", slug: "safe-slug", version: 4, filename: "a...v4.yaml", star: true},
		{name: "empty", title: " \t", slug: "", version: 1, filename: "workflow.yaml"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			header := exportContentDisposition(tc.title, tc.slug, tc.version)
			if strings.Contains(header, "\n") || strings.Contains(header, "\r") {
				t.Fatalf("header contains a newline: %q", header)
			}
			if !headerHasASCIIFilename(header, tc.filename) {
				t.Fatalf("header %q missing ASCII filename %q", header, tc.filename)
			}
			ascii := asciiFilenameParam(header)
			for _, r := range ascii {
				if r > 0x7E || unicode.IsControl(r) {
					t.Fatalf("filename fallback is not ASCII: %q in %q", ascii, header)
				}
			}
			if tc.star {
				if !strings.Contains(header, "filename*=") {
					t.Fatalf("missing filename*: %q", header)
				}
			} else if strings.Contains(header, "filename*=") {
				t.Fatalf("unexpected filename*: %q", header)
			}
			mediaType, _, err := mime.ParseMediaType(strings.Split(header, "filename*")[0])
			if err != nil {
				t.Fatalf("parse fallback %q: %v", header, err)
			}
			if mediaType != "attachment" {
				t.Fatalf("media type = %q", mediaType)
			}
		})
	}
}

func headerHasASCIIFilename(header, want string) bool {
	if strings.Contains(header, `filename="`+want+`"`) {
		return true
	}
	rest := header
	for {
		i := strings.Index(rest, "filename=")
		if i < 0 {
			return false
		}
		rest = rest[i+len("filename="):]
		if strings.HasPrefix(rest, "*") {
			continue
		}
		token := rest
		if cut, _, ok := strings.Cut(token, ";"); ok {
			token = cut
		}
		if strings.TrimSpace(token) == want {
			return true
		}
	}
}

func asciiFilenameParam(header string) string {
	const quoted = `filename="`
	if i := strings.Index(header, quoted); i >= 0 {
		rest := header[i+len(quoted):]
		if j := strings.Index(rest, `"`); j >= 0 {
			return rest[:j]
		}
	}
	const bare = "filename="
	if i := strings.Index(header, bare); i >= 0 && !strings.HasPrefix(header[i+len(bare):], "*") {
		rest := header[i+len(bare):]
		if cut, _, ok := strings.Cut(rest, ";"); ok {
			return strings.TrimSpace(cut)
		}
		return strings.TrimSpace(rest)
	}
	return ""
}
