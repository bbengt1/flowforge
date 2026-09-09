package scripts

import (
	"net/http"
	"strings"
)

// IsolationSpec is the fail-closed environment for one short-lived runner.
// Production pods use the same values as deploy/kubernetes/script-runner-*.yaml.
// CI uses HarnessRuntime, which asserts this spec without starting a container.
type IsolationSpec struct {
	UID                      int          `json:"uid"`
	GID                      int          `json:"gid"`
	ReadOnlyRootFS           bool         `json:"readOnlyRootFS"`
	WorkspacePath            string       `json:"workspacePath"`
	WorkspaceWritable        bool         `json:"workspaceWritable"`
	CPUMillis                int          `json:"cpuMillis"`
	MemoryMiB                int          `json:"memoryMib"`
	TimeoutSeconds           int          `json:"timeoutSeconds"`
	Processes                int          `json:"processes"`
	DropCapabilities         []string     `json:"dropCapabilities"`
	NoNewPrivs               bool         `json:"noNewPrivs"`
	AllowPrivilegeEscalation bool         `json:"allowPrivilegeEscalation"`
	HostDockerSocket         bool         `json:"hostDockerSocket"`
	MetadataService          bool         `json:"metadataService"`
	ServiceAccountMount      bool         `json:"serviceAccountMount"`
	RuntimePackageInstall    bool         `json:"runtimePackageInstall"`
	ApprovedImagesOnly       bool         `json:"approvedImagesOnly"`
	ImageDigest              string       `json:"imageDigest"`
	DependencyLockDigest     string       `json:"dependencyLockDigest"`
	Language                 string       `json:"language"`
	Egress                   EgressPolicy `json:"egress"`
	DNSConstrained           bool         `json:"dnsConstrained"`
	Mode                     string       `json:"mode"`
}

// IsolationReport is the secret-free audit of the environment that ran.
type IsolationReport struct {
	UID                   int          `json:"uid"`
	GID                   int          `json:"gid"`
	ReadOnlyRootFS        bool         `json:"readOnlyRootFS"`
	WorkspacePath         string       `json:"workspacePath"`
	NoNewPrivs            bool         `json:"noNewPrivs"`
	DroppedCapabilities   []string     `json:"droppedCapabilities"`
	HostDockerSocket      bool         `json:"hostDockerSocket"`
	MetadataService       bool         `json:"metadataService"`
	ServiceAccountMount   bool         `json:"serviceAccountMount"`
	RuntimePackageInstall bool         `json:"runtimePackageInstall"`
	ImageDigest           string       `json:"imageDigest"`
	DependencyLockDigest  string       `json:"dependencyLockDigest"`
	CPUMillis             int          `json:"cpuMillis"`
	MemoryMiB             int          `json:"memoryMib"`
	TimeoutSeconds        int          `json:"timeoutSeconds"`
	Processes             int          `json:"processes"`
	Egress                EgressPolicy `json:"egress"`
	Mode                  string       `json:"mode"`
}

// NodeLimits are optional node-level caps that must not exceed the profile.
type NodeLimits struct {
	TimeoutSeconds int
	MemoryMiB      int
	CPUMillis      int
	Processes      int
}

// DefaultIsolationSpec is the MVP runner: non-root, read-only root, dropped
// caps, no_new_privs, no socket/metadata/SA, default-deny egress.
func DefaultIsolationSpec() IsolationSpec {
	return IsolationSpec{
		UID:                      RunnerUID,
		GID:                      RunnerGID,
		ReadOnlyRootFS:           true,
		WorkspacePath:            RunnerWorkspacePath,
		WorkspaceWritable:        true,
		CPUMillis:                250,
		MemoryMiB:                256,
		TimeoutSeconds:           DefaultTimeout,
		Processes:                32,
		DropCapabilities:         []string{CapabilityDropAll},
		NoNewPrivs:               true,
		AllowPrivilegeEscalation: false,
		HostDockerSocket:         false,
		MetadataService:          false,
		ServiceAccountMount:      false,
		RuntimePackageInstall:    false,
		ApprovedImagesOnly:       true,
		DNSConstrained:           true,
		Egress:                   DefaultDenyEgress(),
		Mode:                     IsolationModeHarness,
	}
}

// IsolationFromProfile builds a spec from a pinned runtime_profile plus node caps.
func IsolationFromProfile(language string, spec map[string]any, node NodeLimits) (IsolationSpec, error) {
	if err := ValidateRuntimeProfile(language, spec); err != nil {
		return IsolationSpec{}, err
	}
	out := DefaultIsolationSpec()
	out.Language = strings.ToLower(strings.TrimSpace(language))
	if out.Language == "" {
		out.Language = ProfileLanguage(spec)
	}
	out.ImageDigest, _ = spec["imageDigest"].(string)
	out.DependencyLockDigest, _ = spec["dependencyLockDigest"].(string)
	limits, _ := spec["limits"].(map[string]any)
	if n, ok := asInt(limits["cpuMillis"]); ok {
		out.CPUMillis = n
	}
	if n, ok := asInt(limits["memoryMib"]); ok {
		out.MemoryMiB = n
	}
	if n, ok := asInt(limits["timeoutSeconds"]); ok {
		out.TimeoutSeconds = n
	}
	if n, ok := asInt(limits["processes"]); ok {
		out.Processes = n
	}
	if raw, ok := spec["egress"].(map[string]any); ok {
		policy, err := ParseEgressPolicy(raw)
		if err != nil {
			return IsolationSpec{}, err
		}
		out.Egress = policy
		out.DNSConstrained = policy.DNSConstrained
	}
	if err := applyNodeLimits(&out, node); err != nil {
		return IsolationSpec{}, err
	}
	if err := ValidateIsolation(out); err != nil {
		return IsolationSpec{}, err
	}
	return out, nil
}

func applyNodeLimits(spec *IsolationSpec, node NodeLimits) error {
	if node.TimeoutSeconds > 0 {
		if node.TimeoutSeconds > spec.TimeoutSeconds {
			return engineError(CodeResourceLimit, "timeoutSeconds exceeds the pinned runtime profile.", http.StatusBadRequest)
		}
		spec.TimeoutSeconds = node.TimeoutSeconds
	}
	if node.MemoryMiB > 0 {
		if node.MemoryMiB > spec.MemoryMiB {
			return engineError(CodeResourceLimit, "memoryMiB exceeds the pinned runtime profile.", http.StatusBadRequest)
		}
		spec.MemoryMiB = node.MemoryMiB
	}
	if node.CPUMillis > 0 {
		if node.CPUMillis > spec.CPUMillis {
			return engineError(CodeResourceLimit, "cpuMillis exceeds the pinned runtime profile.", http.StatusBadRequest)
		}
		spec.CPUMillis = node.CPUMillis
	}
	if node.Processes > 0 {
		if node.Processes > spec.Processes {
			return engineError(CodeResourceLimit, "processes exceeds the pinned runtime profile.", http.StatusBadRequest)
		}
		spec.Processes = node.Processes
	}
	return nil
}

// ValidateIsolation fails closed unless every MVP guarantee is present.
func ValidateIsolation(spec IsolationSpec) error {
	if spec.UID <= 0 || spec.UID == 0 {
		return engineError(CodeRootDenied, "script runners must use a non-root UID.", http.StatusForbidden)
	}
	if spec.GID <= 0 {
		return engineError(CodeRootDenied, "script runners must use a non-root GID.", http.StatusForbidden)
	}
	if !spec.ReadOnlyRootFS {
		return engineError(CodeWritableRootFSDenied, "script runners require a read-only root filesystem.", http.StatusForbidden)
	}
	if strings.TrimSpace(spec.WorkspacePath) == "" || !spec.WorkspaceWritable {
		return engineError(CodeIsolationDenied, "script runners require an ephemeral writable workspace.", http.StatusForbidden)
	}
	if !spec.NoNewPrivs {
		return engineError(CodePrivilegeEscalation, "script runners require no_new_privs.", http.StatusForbidden)
	}
	if spec.AllowPrivilegeEscalation {
		return engineError(CodePrivilegeEscalation, "privilege escalation is denied.", http.StatusForbidden)
	}
	if !dropsAllCapabilities(spec.DropCapabilities) {
		return engineError(CodeCapabilityDenied, "script runners must drop all Linux capabilities.", http.StatusForbidden)
	}
	if spec.HostDockerSocket {
		return engineError(CodeDockerSocketDenied, "the host Docker socket is denied.", http.StatusForbidden)
	}
	if spec.MetadataService {
		return engineError(CodeMetadataDenied, "cloud instance metadata access is denied.", http.StatusForbidden)
	}
	if spec.ServiceAccountMount {
		return engineError(CodeServiceAccountDenied, "Kubernetes service-account mounts are denied unless policy authorizes them (MVP deny).", http.StatusForbidden)
	}
	if spec.RuntimePackageInstall {
		return engineError(CodePackageInstallDenied, "runtime package installation is denied.", http.StatusForbidden)
	}
	if !spec.ApprovedImagesOnly {
		return engineError(CodeImageDenied, "arbitrary base images are denied.", http.StatusBadRequest)
	}
	if !digestRE.MatchString(strings.TrimSpace(spec.ImageDigest)) {
		return engineError(CodeImageDenied, "runtime imageDigest must be sha256:<hex>.", http.StatusBadRequest)
	}
	if !digestRE.MatchString(strings.TrimSpace(spec.DependencyLockDigest)) {
		return engineError(CodeInvalidRuntimeProfile, "runtime dependencyLockDigest must be sha256:<hex>.", http.StatusBadRequest)
	}
	if spec.CPUMillis < MinCPUMillis || spec.CPUMillis > MaxCPUMillis {
		return engineError(CodeResourceLimit, "cpuMillis is outside the documented cap.", http.StatusBadRequest)
	}
	if spec.MemoryMiB < MinMemoryMiB || spec.MemoryMiB > MaxMemoryMiB {
		return engineError(CodeResourceLimit, "memoryMiB is outside the documented cap.", http.StatusBadRequest)
	}
	if spec.TimeoutSeconds < MinTimeoutSeconds || spec.TimeoutSeconds > MaxTimeoutSeconds {
		return engineError(CodeResourceLimit, "timeoutSeconds is outside the documented cap.", http.StatusBadRequest)
	}
	if spec.Processes < MinProcesses || spec.Processes > MaxProcesses {
		return engineError(CodeResourceLimit, "processes is outside the documented cap.", http.StatusBadRequest)
	}
	if err := ValidateEgressPolicy(spec.Egress); err != nil {
		return err
	}
	return nil
}

func dropsAllCapabilities(names []string) bool {
	for _, name := range names {
		if strings.EqualFold(strings.TrimSpace(name), CapabilityDropAll) {
			return true
		}
	}
	return false
}

func isolationReport(spec IsolationSpec) IsolationReport {
	return IsolationReport{
		UID:                   spec.UID,
		GID:                   spec.GID,
		ReadOnlyRootFS:        spec.ReadOnlyRootFS,
		WorkspacePath:         spec.WorkspacePath,
		NoNewPrivs:            spec.NoNewPrivs,
		DroppedCapabilities:   append([]string(nil), spec.DropCapabilities...),
		HostDockerSocket:      spec.HostDockerSocket,
		MetadataService:       spec.MetadataService,
		ServiceAccountMount:   spec.ServiceAccountMount,
		RuntimePackageInstall: spec.RuntimePackageInstall,
		ImageDigest:           spec.ImageDigest,
		DependencyLockDigest:  spec.DependencyLockDigest,
		CPUMillis:             spec.CPUMillis,
		MemoryMiB:             spec.MemoryMiB,
		TimeoutSeconds:        spec.TimeoutSeconds,
		Processes:             spec.Processes,
		Egress:                spec.Egress,
		Mode:                  spec.Mode,
	}
}
