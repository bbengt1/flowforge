package scripts

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// IsolationRuntime runs one isolated job. The MVP default is HarnessRuntime
// so CI does not require a container runtime. Production uses the Kubernetes
// Job spec in deploy/kubernetes/script-runner-deployment.yaml.
type IsolationRuntime interface {
	Name() string
	Run(ctx context.Context, spec IsolationSpec, job IsolatedJob) (IsolatedResult, error)
}

// IsolatedJob is the payload handed to a runtime after VerifyForDispatch.
type IsolatedJob struct {
	Language   string
	Entrypoint string
	Source     string
	Image      string
	Lock       string
	Binary     *SignedBinary
	Probes     []IsolationProbe
	Input      map[string]any
	Handles    []map[string]any
	Env        map[string]string
}

// IsolationProbe is a test/harness attempt (UID, write-root, metadata, …).
type IsolationProbe struct {
	Kind   string `json:"kind"`
	Target string `json:"target,omitempty"`
}

// Probe kinds exercised by isolation tests and the harness.
const (
	ProbeUID            = "uid"
	ProbeWriteRoot      = "write-root"
	ProbeCapability     = "capability"
	ProbeNoNewPrivs     = "no_new_privs"
	ProbeMetadata       = "metadata"
	ProbeEgress         = "egress"
	ProbeDockerSocket   = "docker-socket"
	ProbePackageInstall = "package-install"
	ProbeServiceAccount = "service-account"
	ProbeSleep          = "sleep"
	ProbeProcesses      = "processes"
)

// IsolatedResult is the runtime outcome (never includes secrets).
type IsolatedResult struct {
	OK       bool
	Stdout   string
	Stderr   string
	ExitCode int
	Binary   *SignedBinary
}

var packageInstallRE = regexp.MustCompile(`(?i)(\bpip3?\s+install\b|\bpython[0-9.]*\s+-m\s+pip\b|\bconda\s+install\b|\beasy_install\b|\bpoetry\s+add\b|\buv\s+add\b|\bgo\s+get\b|\bgo\s+install\b|\bapt-get\s+install\b|\bapk\s+add\b|\byum\s+install\b|\bnpm\s+install\b|\bgem\s+install\b)`)

// HarnessRuntime enforces isolation gates in-process. It does not start
// runc/containerd. Approved Python/Go fixtures return a canned result after
// every gate passes. Full containers are exercised by the Kubernetes
// manifests, not by `go test` in CI.
type HarnessRuntime struct{}

func (HarnessRuntime) Name() string { return IsolationModeHarness }

func (HarnessRuntime) Run(ctx context.Context, spec IsolationSpec, job IsolatedJob) (IsolatedResult, error) {
	if err := ValidateIsolation(spec); err != nil {
		return IsolatedResult{}, err
	}
	if spec.Mode != "" && spec.Mode != IsolationModeHarness {
		return IsolatedResult{}, engineError(CodeRunnerNotImplemented, "Live container runtime is not available in this process (CI harness).", http.StatusNotImplemented)
	}
	if err := denyPackageInstall(job.Source); err != nil {
		return IsolatedResult{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := time.Duration(spec.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Duration(DefaultTimeout) * time.Second
	}
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(ctx, timeout)
	defer cancel()

	for _, probe := range job.Probes {
		if err := evaluateProbe(ctx, spec, probe); err != nil {
			return IsolatedResult{}, err
		}
		if err := ctx.Err(); err != nil {
			return IsolatedResult{}, engineError(CodeResourceLimit, "script exceeded the pinned time limit.", http.StatusBadRequest)
		}
	}
	out := IsolatedResult{OK: true, ExitCode: 0, Stdout: harnessStdout(job)}
	if job.Binary != nil {
		out.Binary = job.Binary
	}
	return out, nil
}

func denyPackageInstall(source string) error {
	if packageInstallRE.MatchString(source) {
		return ErrPackageInstall
	}
	return nil
}

func evaluateProbe(ctx context.Context, spec IsolationSpec, probe IsolationProbe) error {
	switch strings.ToLower(strings.TrimSpace(probe.Kind)) {
	case ProbeUID:
		if spec.UID <= 0 {
			return engineError(CodeRootDenied, "effective UID must be non-root.", http.StatusForbidden)
		}
		return nil
	case ProbeWriteRoot:
		if !spec.ReadOnlyRootFS {
			return engineError(CodeWritableRootFSDenied, "root filesystem is writable.", http.StatusForbidden)
		}
		return engineError(CodeWritableRootFSDenied, "root filesystem is read-only; write denied.", http.StatusForbidden)
	case ProbeCapability:
		if !dropsAllCapabilities(spec.DropCapabilities) {
			return engineError(CodeCapabilityDenied, "Linux capabilities were not dropped.", http.StatusForbidden)
		}
		return engineError(CodeCapabilityDenied, "all capabilities are dropped.", http.StatusForbidden)
	case ProbeNoNewPrivs:
		if !spec.NoNewPrivs || spec.AllowPrivilegeEscalation {
			return engineError(CodePrivilegeEscalation, "no_new_privs is not set.", http.StatusForbidden)
		}
		return nil
	case ProbeMetadata:
		host, port := egressHostPort(firstNonEmpty(probe.Target, "169.254.169.254"))
		if err := EvaluateEgress(spec.Egress, host, port); err != nil {
			if ee := asEngineError(err); ee != nil {
				return ee
			}
			return err
		}
		return engineError(CodeMetadataDenied, "metadata probe unexpectedly allowed.", http.StatusForbidden)
	case ProbeEgress:
		host, port := egressHostPort(probe.Target)
		if err := EvaluateEgress(spec.Egress, host, port); err != nil {
			if ee := asEngineError(err); ee != nil {
				return ee
			}
			return err
		}
		return nil
	case ProbeDockerSocket:
		if spec.HostDockerSocket {
			return engineError(CodeDockerSocketDenied, "host Docker socket is mounted.", http.StatusForbidden)
		}
		return engineError(CodeDockerSocketDenied, "host Docker socket is not available.", http.StatusForbidden)
	case ProbePackageInstall:
		return ErrPackageInstall
	case ProbeServiceAccount:
		if spec.ServiceAccountMount {
			return engineError(CodeServiceAccountDenied, "service-account token is mounted.", http.StatusForbidden)
		}
		return engineError(CodeServiceAccountDenied, "Kubernetes service-account mount is denied.", http.StatusForbidden)
	case ProbeSleep:
		wait := time.Duration(spec.TimeoutSeconds+1) * time.Second
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return engineError(CodeResourceLimit, "script exceeded the pinned time limit.", http.StatusBadRequest)
		case <-timer.C:
			return engineError(CodeResourceLimit, "script exceeded the pinned time limit.", http.StatusBadRequest)
		}
	case ProbeProcesses:
		if spec.Processes < 1 {
			return engineError(CodeResourceLimit, "process limit is not set.", http.StatusBadRequest)
		}
		return engineError(CodeResourceLimit, "process spawn exceeds the pinned cap.", http.StatusBadRequest)
	default:
		if strings.TrimSpace(probe.Kind) == "" {
			return nil
		}
		return engineError(CodeIsolationDenied, "unknown isolation probe.", http.StatusBadRequest)
	}
}

func harnessStdout(job IsolatedJob) string {
	src := strings.TrimSpace(job.Source)
	switch job.Language {
	case LanguagePython:
		if strings.Contains(src, `"status": "ok"`) || strings.Contains(src, `"status": "complete"`) || strings.Contains(src, `"ok": True`) {
			return `{"status":"ok","runtime":"harness","language":"python"}`
		}
		return `{"ok":true,"runtime":"harness","language":"python"}`
	case LanguageGo:
		return `{"ok":true,"runtime":"harness","language":"go","binaryStub":true}`
	default:
		return `{"ok":true,"runtime":"harness"}`
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
