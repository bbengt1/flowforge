package scriptrun

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunPythonWritesFileAndDoesNotPassSourceAsArg(t *testing.T) {
	root := t.TempDir()
	const src = "print('secret-source-marker')\n"
	var gotArgs []string
	var gotName string
	err := run(context.Background(), mapEnv(map[string]string{
		"FLOWFORGE_LANGUAGE":      "python",
		"FLOWFORGE_ENTRYPOINT":    "main.py",
		"FLOWFORGE_SCRIPT_SOURCE": src,
		"FLOWFORGE_WORKSPACE":     root,
	}), &bytes.Buffer{}, &bytes.Buffer{}, func(_ context.Context, name string, args []string, dir string, _ []string, stdout, _ io.Writer) error {
		gotName = name
		gotArgs = append([]string{}, args...)
		if dir != root {
			t.Fatalf("dir %s", dir)
		}
		_, _ = stdout.Write([]byte(`{"ok":true}`))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotName != "python3" || len(gotArgs) != 1 || gotArgs[0] != filepath.Join(root, "main.py") {
		t.Fatalf("exec %s %v", gotName, gotArgs)
	}
	for _, arg := range gotArgs {
		if strings.Contains(arg, "secret-source-marker") {
			t.Fatal(arg)
		}
	}
	body, err := os.ReadFile(filepath.Join(root, "main.py"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != src {
		t.Fatalf("file %q", body)
	}
}

func TestRunRejectsPathEntrypointAndOmitsSourceFromError(t *testing.T) {
	const src = "print('secret-source-marker')\n"
	err := run(context.Background(), mapEnv(map[string]string{
		"FLOWFORGE_LANGUAGE":      "python",
		"FLOWFORGE_ENTRYPOINT":    "../main.py",
		"FLOWFORGE_SCRIPT_SOURCE": src,
		"FLOWFORGE_WORKSPACE":     t.TempDir(),
	}), &bytes.Buffer{}, &bytes.Buffer{}, func(context.Context, string, []string, string, []string, io.Writer, io.Writer) error {
		t.Fatal("exec")
		return nil
	})
	if Code(err) != codeEntrypoint {
		t.Fatalf("%v", err)
	}
	if strings.Contains(err.Error(), "secret-source-marker") {
		t.Fatal(err)
	}
}

func TestRunGoBuildIsOffline(t *testing.T) {
	root := t.TempDir()
	const src = "package main\nfunc main() {}\n"
	var builds int
	err := run(context.Background(), mapEnv(map[string]string{
		"FLOWFORGE_LANGUAGE":      "go",
		"FLOWFORGE_ENTRYPOINT":    "main.go",
		"FLOWFORGE_SCRIPT_SOURCE": src,
		"FLOWFORGE_WORKSPACE":     root,
	}), &bytes.Buffer{}, &bytes.Buffer{}, func(_ context.Context, name string, args []string, _ string, env []string, _, _ io.Writer) error {
		if name != "go" {
			return nil
		}
		builds++
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "-mod=readonly") || strings.Contains(joined, "package main") {
			t.Fatalf("args %v", args)
		}
		off := false
		for _, e := range env {
			if e == "GOPROXY=off" {
				off = true
			}
			if strings.Contains(e, "package main") {
				t.Fatal(e)
			}
		}
		if !off {
			t.Fatal("GOPROXY=off missing")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if builds != 1 {
		t.Fatalf("go builds %d", builds)
	}
}

func mapEnv(in map[string]string) func(string) string {
	return func(k string) string { return in[k] }
}
