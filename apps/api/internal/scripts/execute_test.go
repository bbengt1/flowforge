package scripts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func operatorPerms() []string {
	return []string{authz.PermWorkflowExecute, authz.PermScriptRun, authz.PermRuntimeProfileUse}
}

func publishedPython(t *testing.T) (Artifact, []byte, map[string]any) {
	t.Helper()
	ctx := context.Background()
	key := NewSigningKey()
	p := &Pipeline{Store: NewMemory(), Key: key}
	art, err := p.Publish(ctx, testScope(t), validPythonInput())
	if err != nil {
		t.Fatal(err)
	}
	return art, key, approvedPythonProfile()
}

func publishedGo(t *testing.T) (Artifact, []byte, map[string]any, string) {
	t.Helper()
	ctx := context.Background()
	key := NewSigningKey()
	p := &Pipeline{Store: NewMemory(), Key: key}
	src := "package main\nfunc main() {}\n"
	profile := map[string]any{
		"language":             "go",
		"imageDigest":          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		"dependencyLockDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		"limits":               map[string]any{"cpuMillis": 250, "memoryMib": 256, "timeoutSeconds": 30, "processes": 32},
	}
	art, err := p.Publish(ctx, testScope(t), PublishInput{
		Language:             LanguageGo,
		Source:               src,
		Entrypoint:           "main.go",
		RuntimeProfileID:     "66666666-6666-4666-8666-666666666666",
		RuntimeProfileDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		RuntimeProfile:       profile,
		TimeoutSeconds:       30,
	})
	if err != nil {
		t.Fatal(err)
	}
	return art, key, profile, src
}

func TestIsolationSpecRejectsUnsafeEnvironment(t *testing.T) {
	base := DefaultIsolationSpec()
	base.ImageDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	base.DependencyLockDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := ValidateIsolation(base); err != nil {
		t.Fatalf("default spec should pass: %v", err)
	}

	cases := []struct {
		name string
		mut  func(*IsolationSpec)
		code string
	}{
		{"root uid", func(s *IsolationSpec) { s.UID = 0 }, CodeRootDenied},
		{"writable root", func(s *IsolationSpec) { s.ReadOnlyRootFS = false }, CodeWritableRootFSDenied},
		{"missing no_new_privs", func(s *IsolationSpec) { s.NoNewPrivs = false }, CodePrivilegeEscalation},
		{"privilege escalation", func(s *IsolationSpec) { s.AllowPrivilegeEscalation = true }, CodePrivilegeEscalation},
		{"caps kept", func(s *IsolationSpec) { s.DropCapabilities = nil }, CodeCapabilityDenied},
		{"docker socket", func(s *IsolationSpec) { s.HostDockerSocket = true }, CodeDockerSocketDenied},
		{"metadata", func(s *IsolationSpec) { s.MetadataService = true }, CodeMetadataDenied},
		{"sa mount", func(s *IsolationSpec) { s.ServiceAccountMount = true }, CodeServiceAccountDenied},
		{"pip install", func(s *IsolationSpec) { s.RuntimePackageInstall = true }, CodePackageInstallDenied},
		{"mutable image", func(s *IsolationSpec) { s.ImageDigest = "python:3.12" }, CodeImageDenied},
		{"arbitrary images", func(s *IsolationSpec) { s.ApprovedImagesOnly = false }, CodeImageDenied},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec := base
			spec.DropCapabilities = append([]string(nil), base.DropCapabilities...)
			tc.mut(&spec)
			err := ValidateIsolation(spec)
			if err == nil {
				t.Fatal("expected isolation denial")
			}
			if ee := asEngineError(err); ee.Code != tc.code {
				t.Fatalf("code = %s want %s (%v)", ee.Code, tc.code, err)
			}
		})
	}
}

func TestExecutePythonFixtureAfterVerify(t *testing.T) {
	art, key, profile := publishedPython(t)
	out := Execute(context.Background(), Request{
		Artifact:       art,
		Source:         validPythonInput().Source,
		Language:       LanguagePython,
		Entrypoint:     "main.py",
		SigningKey:     key,
		RuntimeProfile: profile,
		Permissions:    operatorPerms(),
		CorrelationID:  "corr-python",
		ActorID:        "actor-1",
	})
	if !out.OK || out.Error != nil || !out.SignatureVerified {
		t.Fatalf("result = %+v", out)
	}
	if out.Isolation.UID != RunnerUID || !out.Isolation.ReadOnlyRootFS || !out.Isolation.NoNewPrivs {
		t.Fatalf("isolation = %+v", out.Isolation)
	}
	if out.Isolation.HostDockerSocket || out.Isolation.MetadataService || out.Isolation.ServiceAccountMount {
		t.Fatalf("denied mounts leaked: %+v", out.Isolation)
	}
	if !strings.Contains(out.Stdout, `"language":"python"`) {
		t.Fatalf("stdout = %s", out.Stdout)
	}
}

func TestExecuteGoFixtureSignedBinary(t *testing.T) {
	art, key, profile, src := publishedGo(t)
	out := Execute(context.Background(), Request{
		Artifact:       art,
		Source:         src,
		Language:       LanguageGo,
		Entrypoint:     "main.go",
		SigningKey:     key,
		RuntimeProfile: profile,
		Permissions:    operatorPerms(),
	})
	if !out.OK || out.Error != nil || out.Binary == nil || !out.Binary.Stub {
		t.Fatalf("result = %+v", out)
	}
	if !VerifyGoBinary(key, art, src, "main.go", *out.Binary) {
		t.Fatal("binary signature should verify")
	}
	tampered := art
	tampered.Digest = "sha256:" + strings.Repeat("1", 64)
	if VerifyGoBinary(key, tampered, src, "main.go", *out.Binary) {
		t.Fatal("binary must not verify against a mutated digest")
	}
}

func TestExecuteReverifiesSignatureAndScan(t *testing.T) {
	art, key, profile := publishedPython(t)
	req := Request{
		Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
		Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile, Permissions: operatorPerms(),
	}

	unsigned := req
	unsigned.Artifact.Signature = ""
	if out := Execute(context.Background(), unsigned); out.OK || out.Error == nil || out.Error.Code != CodeArtifactUnsigned {
		t.Fatalf("unsigned = %+v", out)
	}

	failed := req
	failed.Artifact.ScanStatus = ScanFailed
	if out := Execute(context.Background(), failed); out.OK || out.Error == nil || out.Error.Code != CodeArtifactScanFailed {
		t.Fatalf("scan failed = %+v", out)
	}

	draft := req
	draft.Artifact.Status = StatusDraft
	if out := Execute(context.Background(), draft); out.OK || out.Error == nil || out.Error.Code != CodeArtifactMutable {
		t.Fatalf("draft = %+v", out)
	}

	wrongKey := req
	wrongKey.SigningKey = NewSigningKey()
	if out := Execute(context.Background(), wrongKey); out.OK || out.Error == nil || out.Error.Code != CodeArtifactUnsigned {
		t.Fatalf("wrong key = %+v", out)
	}
}

func TestExecuteDeniesPackageInstall(t *testing.T) {
	ctx := context.Background()
	key := NewSigningKey()
	p := &Pipeline{Store: NewMemory(), Key: key}
	in := validPythonInput()
	in.Source = "import os\nos.system('pip install requests')\n"
	art, err := p.Publish(ctx, testScope(t), in)
	if err != nil {
		t.Fatal(err)
	}
	out := Execute(context.Background(), Request{
		Artifact: art, Language: LanguagePython, Entrypoint: "main.py",
		SigningKey: key, RuntimeProfile: approvedPythonProfile(), Permissions: operatorPerms(),
	})
	if out.OK || out.Error == nil || out.Error.Code != CodePackageInstallDenied {
		t.Fatalf("pip install = %+v", out)
	}
	goArt, key2, profile2, src := publishedGo(t)
	out = Execute(context.Background(), Request{
		Artifact: goArt, Source: src, Language: LanguageGo,
		Entrypoint: "main.go", SigningKey: key2, RuntimeProfile: profile2, Permissions: operatorPerms(),
		Probes: []IsolationProbe{{Kind: ProbePackageInstall}},
	})
	if out.OK || out.Error == nil || out.Error.Code != CodePackageInstallDenied {
		t.Fatalf("go get probe = %+v", out)
	}
}

func TestExecuteIsolationProbes(t *testing.T) {
	art, key, profile := publishedPython(t)
	src := validPythonInput().Source
	base := Request{
		Artifact: art, Source: src, Language: LanguagePython, Entrypoint: "main.py",
		SigningKey: key, RuntimeProfile: profile, Permissions: operatorPerms(),
	}

	t.Run("uid is non-root", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeUID}}
		out := Execute(context.Background(), req)
		if !out.OK || out.Isolation.UID != RunnerUID {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("write-root denied", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeWriteRoot}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeWritableRootFSDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("capabilities dropped", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeCapability}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeCapabilityDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("no_new_privs", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeNoNewPrivs}}
		out := Execute(context.Background(), req)
		if !out.OK || !out.Isolation.NoNewPrivs {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("metadata denied", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeMetadata, Target: "169.254.169.254:80"}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeMetadataDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("docker socket denied", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeDockerSocket, Target: "/var/run/docker.sock"}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeDockerSocketDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("service account denied", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeServiceAccount}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeServiceAccountDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("resource time limit", func(t *testing.T) {
		req := base
		req.NodeLimits.TimeoutSeconds = 1
		req.Probes = []IsolationProbe{{Kind: ProbeSleep}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeResourceLimit {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("process cap", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeProcesses}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeResourceLimit {
			t.Fatalf("%+v", out)
		}
	})
}

func TestExecuteEgressAllowlist(t *testing.T) {
	art, key, profile := publishedPython(t)
	profile["egress"] = map[string]any{
		"dnsConstrained": true,
		"destinations": []any{
			map[string]any{"host": "api.example.com", "port": 443, "protocol": "tcp"},
		},
	}
	src := validPythonInput().Source
	base := Request{
		Artifact: art, Source: src, Language: LanguagePython, Entrypoint: "main.py",
		SigningKey: key, RuntimeProfile: profile, Permissions: operatorPerms(),
	}

	t.Run("allowlisted destination", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeEgress, Target: "api.example.com:443"}}
		out := Execute(context.Background(), req)
		if !out.OK {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("unlisted destination denied", func(t *testing.T) {
		req := base
		req.Probes = []IsolationProbe{{Kind: ProbeEgress, Target: "evil.example.net:443"}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeEgressDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("metadata cannot be allowlisted", func(t *testing.T) {
		bad := approvedPythonProfile()
		bad["egress"] = map[string]any{
			"dnsConstrained": true,
			"destinations":   []any{map[string]any{"host": "169.254.169.254", "port": 80}},
		}
		req := base
		req.RuntimeProfile = bad
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeMetadataDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("default deny", func(t *testing.T) {
		req := base
		req.RuntimeProfile = approvedPythonProfile()
		req.Probes = []IsolationProbe{{Kind: ProbeEgress, Target: "api.example.com:443"}}
		out := Execute(context.Background(), req)
		if out.OK || out.Error == nil || out.Error.Code != CodeEgressDenied {
			t.Fatalf("%+v", out)
		}
	})
}

func TestExecuteAuthorizationAndLeaseLoss(t *testing.T) {
	art, key, profile := publishedPython(t)
	t.Run("missing script.run", func(t *testing.T) {
		out := Execute(context.Background(), Request{
			Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
			Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile,
			Permissions: []string{authz.PermWorkflowExecute},
		})
		if out.OK || out.Error == nil || out.Error.Code != CodePermissionDenied {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("lease lost is indeterminate", func(t *testing.T) {
		out := Execute(context.Background(), Request{
			Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
			Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile,
			Permissions: operatorPerms(), LeaseLost: true,
		})
		if out.OK || out.Error == nil || out.Error.Code != CodeIndeterminate {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("live runtime requested", func(t *testing.T) {
		out := Execute(context.Background(), Request{
			Artifact: art, Source: validPythonInput().Source, Language: LanguagePython,
			Entrypoint: "main.py", SigningKey: key, RuntimeProfile: profile,
			Permissions: operatorPerms(), RequireLiveRuntime: true,
		})
		if out.OK || out.Error == nil || out.Error.Code != CodeRunnerNotImplemented {
			t.Fatalf("%+v", out)
		}
	})
}

func TestNodeLimitsCannotExceedProfile(t *testing.T) {
	_, err := IsolationFromProfile(LanguagePython, approvedPythonProfile(), NodeLimits{MemoryMiB: 2048})
	if err == nil {
		t.Fatal("expected resource-limit")
	}
	if ee := asEngineError(err); ee.Code != CodeResourceLimit {
		t.Fatalf("code = %s", ee.Code)
	}
}

func TestCatalogDocumentsRunnerContract(t *testing.T) {
	cat := Catalog()
	if !cat.Isolation.NonRoot || cat.Isolation.UID != RunnerUID || !cat.Isolation.DefaultDenyEgress {
		t.Fatalf("isolation = %+v", cat.Isolation)
	}
	if cat.Isolation.RuntimePackageInstall || cat.Isolation.AllowPrivilegeEscalation {
		t.Fatal("package install / privilege escalation must be false")
	}
	if len(cat.Isolation.KubernetesManifests) != 2 {
		t.Fatalf("manifests = %v", cat.Isolation.KubernetesManifests)
	}
	seen := map[string]bool{}
	for _, e := range cat.Errors {
		seen[e.Code] = true
	}
	for _, code := range []string{CodeMetadataDenied, CodeEgressDenied, CodePackageInstallDenied, CodeImageDenied, CodeResourceLimit} {
		if !seen[code] {
			t.Fatalf("catalog missing error %s", code)
		}
	}
}

func TestScriptRunnerManifestsEncodeIsolation(t *testing.T) {
	root := findRepoRoot(t)
	deploy := filepath.Join(root, "deploy/kubernetes/script-runner-deployment.yaml")
	np := filepath.Join(root, "deploy/kubernetes/script-runner-networkpolicy.yaml")
	body, err := os.ReadFile(deploy)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, needle := range []string{
		"runAsUser: 65532",
		"runAsNonRoot: true",
		"readOnlyRootFilesystem: true",
		"allowPrivilegeEscalation: false",
		"automountServiceAccountToken: false",
		"- ALL",
		"seccompProfile:",
		"emptyDir:",
		"/workspace",
		"image:",
	} {
		if !strings.Contains(text, needle) {
			t.Fatalf("deployment missing %q", needle)
		}
	}
	if strings.Contains(text, "/var/run/docker.sock") {
		t.Fatal("deployment must not mount the Docker socket")
	}
	for _, line := range strings.Split(text, "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "#") {
			continue
		}
		if strings.Contains(trim, "docker.sock") || strings.Contains(trim, ":latest") {
			t.Fatalf("deployment line mounts a socket or latest tag: %s", trim)
		}
	}
	npBody, err := os.ReadFile(np)
	if err != nil {
		t.Fatal(err)
	}
	npText := string(npBody)
	if !strings.Contains(npText, "policyTypes:") || !strings.Contains(npText, "Egress") {
		t.Fatal("network policy must declare egress")
	}
	if !strings.Contains(npText, "port: 53") {
		t.Fatal("constrained DNS (port 53) required")
	}
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "docs/master-implementation-plan.md")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("repo root not found")
	return ""
}
