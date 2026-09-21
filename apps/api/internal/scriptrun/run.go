// Package scriptrun executes one published script inside the isolated
// script-runner image. Callers pass source via FLOWFORGE_SCRIPT_SOURCE.
// This package never logs that source.
package scriptrun

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	codeLanguage   = "invalid-language"
	codeEntrypoint = "invalid-entrypoint"
	codeSource     = "invalid-source"
	codeWorkspace  = "workspace-unavailable"
	codePython     = "python-failed"
	codeGo         = "go-failed"
	codeGoMissing  = "go-unavailable"
)

// Error is a secret-free failure. Error() is the code only.
type Error struct {
	code string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.code
}

// Code returns the public error code, or "script-failed" for other errors.
func Code(err error) string {
	if err == nil {
		return ""
	}
	if e, ok := err.(*Error); ok && e.code != "" {
		return e.code
	}
	return "script-failed"
}

func coded(code string) error {
	return &Error{code: code}
}

// Run executes the script described by getenv. stdout receives the script
// process stdout. Compile and interpreter diagnostics go to stderr.
func Run(ctx context.Context, getenv func(string) string, stdout, stderr io.Writer) error {
	return run(ctx, getenv, stdout, stderr, defaultExec)
}

type execFunc func(ctx context.Context, name string, args []string, dir string, env []string, stdout, stderr io.Writer) error

func defaultExec(ctx context.Context, name string, args []string, dir string, env []string, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if len(env) > 0 {
		cmd.Env = env
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func run(ctx context.Context, getenv func(string) string, stdout, stderr io.Writer, runCmd execFunc) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	if ctx == nil {
		ctx = context.Background()
	}
	lang := strings.ToLower(strings.TrimSpace(first(getenv, "FLOWFORGE_LANGUAGE", "FLOWFORGE_SCRIPT_LANGUAGE")))
	source := getenv("FLOWFORGE_SCRIPT_SOURCE")
	if strings.TrimSpace(source) == "" {
		return coded(codeSource)
	}
	root := strings.TrimSpace(getenv("FLOWFORGE_WORKSPACE"))
	if root == "" {
		root = "/workspace"
	}
	if !filepath.IsAbs(root) {
		return coded(codeWorkspace)
	}
	switch lang {
	case "python":
		entry, err := cleanEntrypoint(getenv("FLOWFORGE_ENTRYPOINT"), "main.py")
		if err != nil {
			return err
		}
		return runPython(ctx, runCmd, root, entry, source, stdout, stderr)
	case "go":
		entry, err := cleanEntrypoint(getenv("FLOWFORGE_ENTRYPOINT"), "main.go")
		if err != nil {
			return err
		}
		return runGo(ctx, runCmd, root, entry, source, stdout, stderr)
	default:
		return coded(codeLanguage)
	}
}

func runPython(ctx context.Context, runCmd execFunc, root, entry, source string, stdout, stderr io.Writer) error {
	path, err := writeSource(root, entry, source)
	if err != nil {
		return err
	}
	if err := runCmd(ctx, "python3", []string{path}, root, nil, stdout, stderr); err != nil {
		return coded(codePython)
	}
	return nil
}

func runGo(ctx context.Context, runCmd execFunc, root, entry, source string, stdout, stderr io.Writer) error {
	dir := filepath.Join(root, "src")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return coded(codeWorkspace)
	}
	if _, err := writeSource(dir, entry, source); err != nil {
		return err
	}
	mod := "module flowforge.script\n\ngo 1.26.0\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(mod), 0o644); err != nil {
		return coded(codeWorkspace)
	}
	bin := filepath.Join(root, "program")
	env := append(append([]string{}, os.Environ()...),
		"GO111MODULE=on",
		"GOPROXY=off",
		"GOSUMDB=off",
		"GOTOOLCHAIN=local",
		"CGO_ENABLED=0",
		"GOCACHE="+filepath.Join(root, ".cache"),
		"GOMODCACHE="+filepath.Join(root, ".mod"),
		"GOTMPDIR="+filepath.Join(root, ".tmp"),
		"HOME="+root,
	)
	if err := os.MkdirAll(filepath.Join(root, ".tmp"), 0o755); err != nil {
		return coded(codeWorkspace)
	}
	// Compile diagnostics go to stderr. Program stdout stays the script result.
	if err := runCmd(ctx, "go", []string{"build", "-mod=readonly", "-o", bin, "."}, dir, env, stderr, stderr); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return coded(codeGoMissing)
		}
		return coded(codeGo)
	}
	if err := runCmd(ctx, bin, nil, root, nil, stdout, stderr); err != nil {
		return coded(codeGo)
	}
	return nil
}

func writeSource(dir, name, source string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", coded(codeWorkspace)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		return "", coded(codeWorkspace)
	}
	return path, nil
}

func cleanEntrypoint(name, fallback string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = fallback
	}
	if name != filepath.Base(name) || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		return "", coded(codeEntrypoint)
	}
	if name == "." || len(name) > 256 {
		return "", coded(codeEntrypoint)
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-':
		default:
			return "", coded(codeEntrypoint)
		}
	}
	return name, nil
}

func first(getenv func(string) string, keys ...string) string {
	for _, key := range keys {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
	}
	return ""
}
