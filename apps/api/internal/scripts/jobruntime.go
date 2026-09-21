package scripts

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Published script-runner image. The Job template references the tag.
// Each created Job is rewritten to ScriptRunnerRepository@<imageDigest>
// from the pinned runtime profile. CI rejects :latest; operators replace
// the tag with a digest in the manifest before a real cluster rollout.
const (
	ScriptRunnerRepository = "ghcr.io/bbengt1/flowforge-script-runner"
	ScriptRunnerTag        = "foundation"
	ScriptRunnerImageRef   = ScriptRunnerRepository + ":" + ScriptRunnerTag
)

//go:embed script_runner_job.yaml
var embeddedScriptJobTemplate []byte

// EmbeddedScriptJobTemplate is the Job template shipped in the runner
// binary. It must match deploy/kubernetes/script-runner-deployment.yaml.
func EmbeddedScriptJobTemplate() []byte {
	return append([]byte(nil), embeddedScriptJobTemplate...)
}

// JobSubmitter creates one isolated Job and returns the container result.
// Implementations must not log the manifest (it carries published source).
type JobSubmitter interface {
	Submit(ctx context.Context, manifest map[string]any) (IsolatedResult, error)
}

// KubernetesJobRuntime implements IsolationRuntime by cloning the script
// runner Job template and submitting one Job per step. Name is the live
// mode, so Execute with RequireLiveRuntime will not fall back to the harness.
type KubernetesJobRuntime struct {
	Template  []byte
	Namespace string
	Submitter JobSubmitter
}

// Name reports the live Kubernetes isolation mode.
func (KubernetesJobRuntime) Name() string { return IsolationModeLive }

// Run renders one Job from the template and submits it.
func (r KubernetesJobRuntime) Run(ctx context.Context, spec IsolationSpec, job IsolatedJob) (IsolatedResult, error) {
	if err := ValidateIsolation(spec); err != nil {
		return IsolatedResult{}, err
	}
	if r.Submitter == nil {
		return IsolatedResult{}, engineError(CodeRunnerNotImplemented, "script runner Job client is not configured.", http.StatusNotImplemented)
	}
	manifest, err := RenderScriptJob(r.Template, r.Namespace, spec, job)
	if err != nil {
		return IsolatedResult{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return r.Submitter.Submit(ctx, manifest)
}

// RenderScriptJob clones the embedded or operator template into one Job.
// The container image is repository@spec.ImageDigest. Published source is
// placed in FLOWFORGE_SCRIPT_SOURCE. Credential-shaped env is rejected.
func RenderScriptJob(template []byte, namespace string, spec IsolationSpec, job IsolatedJob) (map[string]any, error) {
	if len(template) == 0 {
		template = embeddedScriptJobTemplate
	}
	obj, err := parseJobTemplate(template)
	if err != nil {
		return nil, err
	}
	if err := validateJobTemplate(obj); err != nil {
		return nil, err
	}
	ns := strings.TrimSpace(namespace)
	if !validJobNamespace(ns) {
		return nil, engineError(CodeIsolationDenied, "script Job namespace is invalid.", http.StatusForbidden)
	}
	if err := rejectSecretMaterial(job.Source); err != nil {
		return nil, err
	}
	if len(job.Source) > MaxSourceBytes {
		return nil, engineError(CodeSizeLimit, "script source exceeds the size limit.", http.StatusBadRequest)
	}
	entry, err := jobEntrypoint(job)
	if err != nil {
		return nil, err
	}
	name, err := scriptJobName()
	if err != nil {
		return nil, engineError(CodeIsolationDenied, "script Job name could not be allocated.", http.StatusForbidden)
	}
	meta := mustMap(obj, "metadata")
	meta["name"] = name
	meta["namespace"] = ns
	ensureScriptLabels(meta)

	jobSpec := mustMap(obj, "spec")
	jobSpec["backoffLimit"] = float64(0)
	jobSpec["activeDeadlineSeconds"] = float64(spec.TimeoutSeconds)
	if _, ok := jobSpec["ttlSecondsAfterFinished"]; !ok {
		jobSpec["ttlSecondsAfterFinished"] = float64(600)
	}

	podMeta := mustMap(mustMap(jobSpec, "template"), "metadata")
	ensureScriptLabels(podMeta)
	pod := mustMap(mustMap(jobSpec, "template"), "spec")
	pod["restartPolicy"] = "Never"
	pod["automountServiceAccountToken"] = false
	delete(pod, "serviceAccountName")
	delete(pod, "serviceAccount")

	container, err := runnerContainer(pod)
	if err != nil {
		return nil, err
	}
	pinned, err := pinScriptImage(spec.ImageDigest)
	if err != nil {
		return nil, err
	}
	container["image"] = pinned
	container["imagePullPolicy"] = "IfNotPresent"
	container["command"] = []any{"/usr/local/bin/scriptrunner"}
	delete(container, "args")
	env, err := scriptJobEnv(job, entry)
	if err != nil {
		return nil, err
	}
	container["env"] = env
	cpu := strconv.Itoa(spec.CPUMillis) + "m"
	mem := strconv.Itoa(spec.MemoryMiB) + "Mi"
	container["resources"] = map[string]any{
		"requests": map[string]any{"cpu": cpu, "memory": mem},
		"limits":   map[string]any{"cpu": cpu, "memory": mem},
	}
	if err := rejectSecretTree(obj); err != nil {
		return nil, err
	}
	if walkHas(obj, "hostPath") || strings.Contains(mustJSON(obj), "docker.sock") || strings.Contains(mustJSON(obj), ":latest") {
		return nil, engineError(CodeDockerSocketDenied, "script Job template is not isolated.", http.StatusForbidden)
	}
	return obj, nil
}

func parseJobTemplate(raw []byte) (map[string]any, error) {
	var doc any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, engineError(CodeInvalidRuntimeProfile, "script Job template could not be parsed.", http.StatusBadRequest)
	}
	buf, err := json.Marshal(doc)
	if err != nil {
		return nil, engineError(CodeInvalidRuntimeProfile, "script Job template could not be parsed.", http.StatusBadRequest)
	}
	var obj map[string]any
	if err := json.Unmarshal(buf, &obj); err != nil || obj == nil {
		return nil, engineError(CodeInvalidRuntimeProfile, "script Job template could not be parsed.", http.StatusBadRequest)
	}
	return obj, nil
}

func validateJobTemplate(obj map[string]any) error {
	if obj["kind"] != "Job" || obj["apiVersion"] != "batch/v1" {
		return engineError(CodeIsolationDenied, "script runner template must be a batch/v1 Job.", http.StatusForbidden)
	}
	if walkHas(obj, "replicas") {
		return engineError(CodeIsolationDenied, "script runner template must not set replicas.", http.StatusForbidden)
	}
	pod := mustMap(mustMap(mustMap(obj, "spec"), "template"), "spec")
	if pod == nil {
		return engineError(CodeIsolationDenied, "script Job template is missing a pod spec.", http.StatusForbidden)
	}
	if pod["restartPolicy"] != "Never" {
		return engineError(CodeIsolationDenied, "script Jobs must set restartPolicy Never.", http.StatusForbidden)
	}
	if pod["automountServiceAccountToken"] != false {
		return engineError(CodeServiceAccountDenied, "script Jobs must not mount a service account token.", http.StatusForbidden)
	}
	if truthyAny(pod["hostNetwork"]) || truthyAny(pod["hostPID"]) || truthyAny(pod["hostIPC"]) {
		return engineError(CodeIsolationDenied, "script Jobs must not share the host namespace.", http.StatusForbidden)
	}
	container, err := runnerContainer(pod)
	if err != nil {
		return err
	}
	image, _ := container["image"].(string)
	if strings.TrimSpace(image) != ScriptRunnerImageRef {
		return engineError(CodeImageDenied, "script Job template image is not the published script-runner reference.", http.StatusForbidden)
	}
	sc := mustMap(container, "securityContext")
	if sc["readOnlyRootFilesystem"] != true || sc["allowPrivilegeEscalation"] != false || sc["runAsNonRoot"] != true {
		return engineError(CodeIsolationDenied, "script Job container securityContext is not isolated.", http.StatusForbidden)
	}
	uid, ok := asInt(sc["runAsUser"])
	gid, okG := asInt(sc["runAsGroup"])
	if !ok || !okG || uid != RunnerUID || gid != RunnerGID {
		return engineError(CodeRootDenied, "script Job container must run as UID/GID 65532.", http.StatusForbidden)
	}
	caps := mustMap(sc, "capabilities")
	drop, _ := caps["drop"].([]any)
	if !stringListHas(drop, CapabilityDropAll) {
		return engineError(CodeCapabilityDenied, "script Jobs must drop all Linux capabilities.", http.StatusForbidden)
	}
	if !mountsWorkspace(container) {
		return engineError(CodeIsolationDenied, "script Jobs require an ephemeral /workspace.", http.StatusForbidden)
	}
	raw := mustJSON(obj)
	if strings.Contains(raw, "docker.sock") || strings.Contains(raw, ":latest") || strings.Contains(raw, "hostPath") {
		return engineError(CodeDockerSocketDenied, "script Job template is not isolated.", http.StatusForbidden)
	}
	return nil
}

func pinScriptImage(digest string) (string, error) {
	digest = strings.TrimSpace(digest)
	if !digestRE.MatchString(digest) {
		return "", engineError(CodeImageDenied, "runtime imageDigest must be sha256:<hex>.", http.StatusBadRequest)
	}
	return ScriptRunnerRepository + "@" + digest, nil
}

func scriptJobEnv(job IsolatedJob, entry string) ([]any, error) {
	vals := map[string]string{}
	for k, v := range job.Env {
		if !allowedRuntimeEnv[k] {
			continue
		}
		if err := rejectSecretMaterial(v); err != nil {
			return nil, err
		}
		vals[k] = v
	}
	vals["FLOWFORGE_LANGUAGE"] = strings.ToLower(strings.TrimSpace(job.Language))
	vals["FLOWFORGE_ENTRYPOINT"] = entry
	vals["FLOWFORGE_SCRIPT_SOURCE"] = job.Source
	vals["HOME"] = RunnerWorkspacePath
	vals["GOCACHE"] = RunnerWorkspacePath + "/.cache"
	vals["GOMODCACHE"] = RunnerWorkspacePath + "/.mod"
	vals["GOTMPDIR"] = "/tmp"
	vals["GOPROXY"] = "off"
	vals["GOSUMDB"] = "off"
	vals["GOTOOLCHAIN"] = "local"
	vals["CGO_ENABLED"] = "0"
	vals["GO111MODULE"] = "on"
	order := []string{
		"FLOWFORGE_LANGUAGE",
		"FLOWFORGE_ENTRYPOINT",
		"FLOWFORGE_SCRIPT_SOURCE",
		"FLOWFORGE_CORRELATION_ID",
		"FLOWFORGE_ARTIFACT_DIGEST",
		"FLOWFORGE_RUNTIME_PROFILE_ID",
		"FLOWFORGE_HANDLE_IDS",
		"FLOWFORGE_IDEMPOTENCY_KEY",
		"HOME",
		"GOCACHE",
		"GOMODCACHE",
		"GOTMPDIR",
		"GOPROXY",
		"GOSUMDB",
		"GOTOOLCHAIN",
		"CGO_ENABLED",
		"GO111MODULE",
	}
	var out []any
	for _, key := range order {
		val, ok := vals[key]
		if !ok || strings.TrimSpace(val) == "" {
			continue
		}
		out = append(out, map[string]any{"name": key, "value": val})
	}
	return out, nil
}

func jobEntrypoint(job IsolatedJob) (string, error) {
	name := strings.TrimSpace(job.Entrypoint)
	if name == "" {
		if strings.EqualFold(job.Language, LanguageGo) {
			name = "main.go"
		} else {
			name = "main.py"
		}
	}
	if strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) || name == "." || len(name) > MaxEntrypointBytes {
		return "", engineError(CodeInvalidEntrypoint, "script entrypoint is not a single file name.", http.StatusBadRequest)
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.' || r == '_' || r == '-':
		default:
			return "", engineError(CodeInvalidEntrypoint, "script entrypoint is not a single file name.", http.StatusBadRequest)
		}
	}
	return name, nil
}

func scriptJobName() (string, error) {
	var b [5]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "ff-script-" + hex.EncodeToString(b[:]), nil
}

func validJobNamespace(ns string) bool {
	if ns == "" || len(ns) > 63 {
		return false
	}
	for i, r := range ns {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-':
			if i == 0 || i == len(ns)-1 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func ensureScriptLabels(meta map[string]any) {
	if meta == nil {
		return
	}
	labels, _ := meta["labels"].(map[string]any)
	if labels == nil {
		labels = map[string]any{}
		meta["labels"] = labels
	}
	labels["app.kubernetes.io/name"] = "flowforge"
	labels["app.kubernetes.io/component"] = "script-runner"
	labels["app.kubernetes.io/part-of"] = "flowforge"
}

func runnerContainer(pod map[string]any) (map[string]any, error) {
	containers, _ := pod["containers"].([]any)
	for _, item := range containers {
		cm, _ := item.(map[string]any)
		if cm != nil && cm["name"] == "runner" {
			return cm, nil
		}
	}
	return nil, engineError(CodeIsolationDenied, "script Job template is missing the runner container.", http.StatusForbidden)
}

func mountsWorkspace(container map[string]any) bool {
	mounts, _ := container["volumeMounts"].([]any)
	for _, item := range mounts {
		m, _ := item.(map[string]any)
		if m != nil && m["mountPath"] == RunnerWorkspacePath {
			return true
		}
	}
	return false
}

func mustMap(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	n, _ := m[key].(map[string]any)
	return n
}

func stringListHas(list []any, want string) bool {
	for _, item := range list {
		s, _ := item.(string)
		if strings.EqualFold(strings.TrimSpace(s), want) {
			return true
		}
	}
	return false
}

func truthyAny(v any) bool {
	b, _ := v.(bool)
	return b
}

func walkHas(v any, key string) bool {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			if k == key || walkHas(child, key) {
				return true
			}
		}
	case []any:
		for _, child := range t {
			if walkHas(child, key) {
				return true
			}
		}
	}
	return false
}

func mustJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(raw)
}

func rejectSecretMaterial(value string) error {
	if value == "" {
		return nil
	}
	if irredactableSecret([]byte(value)) {
		return engineError(CodeSecretForbidden, "script Job rejected credential material.", http.StatusForbidden)
	}
	return nil
}

func rejectSecretTree(v any) error {
	switch t := v.(type) {
	case map[string]any:
		for _, child := range t {
			if err := rejectSecretTree(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range t {
			if err := rejectSecretTree(child); err != nil {
				return err
			}
		}
	case string:
		return rejectSecretMaterial(t)
	}
	return nil
}
