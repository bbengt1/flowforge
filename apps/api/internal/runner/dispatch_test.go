package runner

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpnotify"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/kubernetes"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	cryptossh "golang.org/x/crypto/ssh"
)

const (
	wsID     = "11111111-1111-4111-8111-111111111111"
	actorID  = "22222222-2222-4222-8222-222222222222"
	targetID = "11111111-1111-4111-8111-111111111111"
	policyID = "44444444-4444-4444-8444-444444444444"
	sshID    = "33333333-3333-4333-8333-333333333333"
	profID   = "55555555-5555-4555-8555-555555555555"
	rtID     = "66666666-6666-4666-8666-666666666666"
	connID   = "77777777-7777-4777-8777-777777777777"
	listID   = "88888888-8888-4888-8888-888888888888"
	tmplID   = "99999999-9999-4999-8999-999999999999"
	localMsg = "Deploy an isolated production worker"
	kubeTok  = "very-secret-token"
)

func TestClaimKubernetesApplyCompleteAndFence(t *testing.T) {
	r, fake := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	cred := r.kubeCred(t)
	ver := r.publish(t, k8sYAML)
	r.bind(t, ver.ID, clusterPin(cred))
	exec := r.start(t, ver)
	if n, err := r.loop.Drain(context.Background()); err != nil || n != 1 {
		t.Fatalf("drain n=%d err=%v", n, err)
	}
	job := r.onlyJob(t, exec.ID)
	if job.Status != wfstore.JobSucceeded {
		t.Fatalf("status %s err=%v", job.Status, r.onlyStep(t, exec.ID).Error)
	}
	if fake.Applies == 0 || fake.DryRuns == 0 {
		t.Fatalf("cluster not contacted dry=%d apply=%d", fake.DryRuns, fake.Applies)
	}
	raw := r.trace(t, exec.ID)
	if strings.Contains(raw, kubeTok) || strings.Contains(raw, "BEGIN CERTIFICATE") {
		t.Fatalf("secret leaked: %s", raw)
	}
	if strings.Contains(raw, localMsg) {
		t.Fatalf("local worker message: %s", raw)
	}
	_, err := r.wf.CompleteJob(context.Background(), r.scope, time.Now().UTC(), wfstore.JobActionInput{
		JobID: job.ID, WorkerID: r.queue.WorkerID, FencingToken: 0,
	})
	if !errors.Is(err, wfstore.ErrFenceConflict) {
		t.Fatalf("stale fence: %v", err)
	}
}

func TestPolicyDenyFailsClosedAndFence(t *testing.T) {
	r, fake := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	cred := r.kubeCred(t)
	ver := r.publish(t, strings.Replace(k8sYAML, "dryRun: server", "dryRun: server\n        policyId: "+policyID, 1))
	r.bind(t, ver.ID, clusterPin(cred), opsconfig.Pin{
		Kind: opsconfig.KindPolicy, ResourceID: policyID, VersionID: policyID, VersionNumber: 1,
		Digest: "sha256:" + strings.Repeat("d", 64),
		Spec: map[string]any{
			"kind": "kubernetes",
			"policy": map[string]any{
				"deny":       true,
				"namespaces": []any{"cp-ops-nprd"},
				"kinds":      []any{"ConfigMap"},
				"verbs":      []any{"apply"},
			},
		},
	})
	exec := r.start(t, ver)
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	job := r.onlyJob(t, exec.ID)
	step := r.onlyStep(t, exec.ID)
	if job.Status != wfstore.JobFailed || step.Error["code"] != kubernetes.CodePolicyDenied {
		t.Fatalf("job=%s err=%v", job.Status, step.Error)
	}
	if fake.Applies != 0 || fake.DryRuns != 0 {
		t.Fatal("cluster contacted after policy deny")
	}
	if strings.Contains(r.trace(t, exec.ID), localMsg) {
		t.Fatal("local worker message")
	}
	_, err := r.wf.FailJob(context.Background(), r.scope, time.Now().UTC(), wfstore.JobActionInput{
		JobID: job.ID, WorkerID: r.queue.WorkerID, FencingToken: 0,
	})
	if !errors.Is(err, wfstore.ErrFenceConflict) {
		t.Fatalf("stale fence: %v", err)
	}
}

func TestViewerCannotApply(t *testing.T) {
	r, fake := newRig(t, authz.ExpandRoles([]string{authz.RoleViewer}))
	cred := r.kubeCred(t)
	ver := r.publish(t, k8sYAML)
	r.bind(t, ver.ID, clusterPin(cred))
	exec := r.start(t, ver)
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	step := r.onlyStep(t, exec.ID)
	if r.onlyJob(t, exec.ID).Status != wfstore.JobFailed || step.Error["code"] != kubernetes.CodePermissionDenied {
		t.Fatalf("err=%v", step.Error)
	}
	if fake.Applies != 0 {
		t.Fatal("viewer apply reached the cluster")
	}
}

func TestFlowDelayAndDataSet(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	delay := r.start(t, r.publish(t, coreYAML("wait", "flow.delay", "duration: PT5S")))
	set := r.start(t, r.publish(t, coreYAML("set", "data.set", "value:\n          status: ok")))
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	dStep := r.onlyStep(t, delay.ID)
	if r.onlyJob(t, delay.ID).Status != wfstore.JobFailed || dStep.Error["code"] != CodeUnsupported {
		t.Fatalf("delay=%v", dStep.Error)
	}
	msg, _ := dStep.Error["message"].(string)
	if strings.Contains(msg, localMsg) {
		t.Fatal(msg)
	}
	if r.onlyJob(t, set.ID).Status != wfstore.JobSucceeded {
		t.Fatalf("data.set %s %v", r.onlyJob(t, set.ID).Status, r.onlyStep(t, set.ID).Error)
	}
}

func TestApprovalIsParked(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	exec := r.start(t, r.publish(t, coreYAML("gate", "flow.approval", "approverRole: approver\n        expiresIn: PT1H")))
	if n, err := r.loop.Drain(context.Background()); err != nil || n != 1 {
		t.Fatalf("drain n=%d err=%v", n, err)
	}
	job := r.onlyJob(t, exec.ID)
	if job.Status != wfstore.JobWaiting || job.LeaseExpiresAt != nil {
		t.Fatalf("parked=%+v", job)
	}
}

func TestScriptHarnessAndMissingPin(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	src := "import json\nprint(json.dumps({\"status\": \"ok\"}))\n"
	yaml := scriptYAML(src)
	ver := r.publish(t, yaml)
	art := r.publishScript(t, src)
	if _, err := r.scripts.BindVersion(context.Background(), r.scope, ver.ID, []scripts.VersionPin{{
		WorkflowVersionID: ver.ID,
		NodeID:            "run",
		NodeType:          scripts.NodePython,
		ArtifactID:        art.ID,
		Digest:            art.Digest,
		ScanStatus:        art.ScanStatus,
		Signature:         art.Signature,
		Language:          art.Language,
		Entrypoint:        art.Entrypoint,
	}}); err != nil {
		t.Fatal(err)
	}
	r.bind(t, ver.ID, runtimePin())
	exec := r.start(t, ver)
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	step := r.onlyStep(t, exec.ID)
	if r.onlyJob(t, exec.ID).Status != wfstore.JobSucceeded {
		t.Fatalf("script %v", step.Error)
	}
	raw := r.trace(t, exec.ID)
	if !strings.Contains(raw, "harness") || strings.Contains(raw, localMsg) {
		t.Fatalf("trace=%s", raw)
	}

	panicRT := &panicRuntime{}
	r.disp.Engines.Script = panicRT
	missingYAML := strings.Replace(scriptYAML("print('yaml-only-source')\n"), "name: script", "name: script-missing", 1)
	missing := r.start(t, r.publish(t, missingYAML))
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	miss := r.onlyStep(t, missing.ID)
	if r.onlyJob(t, missing.ID).Status != wfstore.JobFailed || miss.Error["code"] != CodeUnpublishedPin {
		t.Fatalf("missing pin %v", miss.Error)
	}
	if panicRT.called {
		t.Fatal("yaml source was executed")
	}
}

func TestScriptJobCreatedFromTemplate(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	jobs := &recordingJobs{stdout: `{"status":"ok","runtime":"kubernetes"}`}
	r.disp.Engines.Script = scripts.KubernetesJobRuntime{
		Template:  scripts.EmbeddedScriptJobTemplate(),
		Namespace: "flowforge",
		Submitter: jobs,
	}
	scope, err := isolation.Authorize(wsID, actorID)
	if err != nil {
		t.Fatal(err)
	}
	draft := r.disp.Execute(context.Background(), scope, authz.ExpandRoles([]string{authz.RoleOperator}), Job{
		Binding:   wfstore.JobBinding{WorkspaceID: wsID, JobID: actorID, ExecutionID: targetID, ExpiresAt: time.Now().Add(time.Minute)},
		Step:      wfstore.ExecutionStep{NodeType: scripts.NodePython, NodeID: "run"},
		Execution: wfstore.Execution{},
		Job:       wfstore.ExecutionJob{Status: wfstore.JobRunning},
	})
	if !draft.Fail || draft.Error["code"] != CodeDraftNotRunnable || jobs.n != 0 {
		t.Fatalf("draft %+v submits %d", draft, jobs.n)
	}

	src := "import json\nprint(json.dumps({\"status\": \"ok\"}))\n"
	ver := r.publish(t, scriptYAML(src))
	art := r.publishScript(t, src)
	if _, err := r.scripts.BindVersion(context.Background(), r.scope, ver.ID, []scripts.VersionPin{{
		WorkflowVersionID: ver.ID,
		NodeID:            "run",
		NodeType:          scripts.NodePython,
		ArtifactID:        art.ID,
		Digest:            art.Digest,
		ScanStatus:        art.ScanStatus,
		Signature:         art.Signature,
		Language:          art.Language,
		Entrypoint:        art.Entrypoint,
	}}); err != nil {
		t.Fatal(err)
	}
	r.bind(t, ver.ID, runtimePin())
	exec := r.start(t, ver)
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.onlyJob(t, exec.ID).Status != wfstore.JobSucceeded {
		t.Fatalf("script %v", r.onlyStep(t, exec.ID).Error)
	}
	if jobs.n != 1 || jobs.manifest["kind"] != "Job" {
		t.Fatalf("jobs %d kind %v", jobs.n, jobs.manifest["kind"])
	}
	raw, err := json.Marshal(jobs.manifest)
	if err != nil {
		t.Fatal(err)
	}
	image := scripts.ScriptRunnerRepository + "@sha256:" + strings.Repeat("a", 64)
	if !bytes.Contains(raw, []byte(image)) {
		t.Fatalf("image missing: %s", raw)
	}
	if bytes.Contains(raw, []byte("replicas")) || bytes.Contains(raw, []byte(hex.EncodeToString(r.sign))) {
		t.Fatalf("replicas or signing key in job: %s", raw)
	}
	trace := r.trace(t, exec.ID)
	if !strings.Contains(trace, `"mode":"kubernetes"`) || strings.Contains(trace, localMsg) {
		t.Fatalf("trace=%s", trace)
	}
	if strings.Contains(trace, hex.EncodeToString(r.sign)) || strings.Contains(r.log.String(), src) {
		t.Fatal("secret or source leaked into the runner log or step output")
	}

	before := jobs.n
	missingYAML := strings.Replace(scriptYAML("print('yaml-only-source')\n"), "name: script", "name: script-job-missing", 1)
	missing := r.start(t, r.publish(t, missingYAML))
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	miss := r.onlyStep(t, missing.ID)
	if r.onlyJob(t, missing.ID).Status != wfstore.JobFailed || miss.Error["code"] != CodeUnpublishedPin || jobs.n != before {
		t.Fatalf("missing pin %v submits %d", miss.Error, jobs.n)
	}
}

type recordingJobs struct {
	n        int
	manifest map[string]any
	stdout   string
}

func (r *recordingJobs) Submit(_ context.Context, manifest map[string]any) (scripts.IsolatedResult, error) {
	r.n++
	raw, err := json.Marshal(manifest)
	if err != nil {
		return scripts.IsolatedResult{}, err
	}
	var clone map[string]any
	if err := json.Unmarshal(raw, &clone); err != nil {
		return scripts.IsolatedResult{}, err
	}
	r.manifest = clone
	return scripts.IsolatedResult{OK: true, ExitCode: 0, Stdout: r.stdout}, nil
}

func TestSSHRun(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	transport := &fakeSSH{}
	r.disp.Engines.SSH = transport
	cred := r.secret(t, vault.TypeSSHPrivateKey, map[string]string{"privateKey": ed25519PEM(t)})
	ver := r.publish(t, sshYAML)
	r.bind(t, ver.ID, sshTargetPin(cred), commandPin())
	exec := r.start(t, ver)
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	step := r.onlyStep(t, exec.ID)
	if r.onlyJob(t, exec.ID).Status != wfstore.JobSucceeded {
		t.Fatalf("ssh %v", step.Error)
	}
	if !transport.signer {
		t.Fatal("ssh transport did not receive a signer")
	}
	raw := r.trace(t, exec.ID)
	if !strings.Contains(raw, `"stdout":"ok"`) && !strings.Contains(raw, `"stdout": "ok"`) {
		t.Fatalf("stdout missing: %s", raw)
	}
	if strings.Contains(raw, "PRIVATE KEY") || strings.Contains(raw, localMsg) {
		t.Fatalf("leak or local message: %s", raw)
	}
}

func TestHTTPRequestRedactsToken(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	r.disp.Engines.HTTP = fakeRT{}
	const token = "runner-http-secret-token"
	cred := r.secret(t, vault.TypeToken, map[string]string{"token": token})
	ver := r.publish(t, httpYAML)
	r.bind(t, ver.ID, httpPin(cred))
	exec := r.start(t, ver)
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.onlyJob(t, exec.ID).Status != wfstore.JobSucceeded {
		t.Fatalf("http %v", r.onlyStep(t, exec.ID).Error)
	}
	if strings.Contains(r.trace(t, exec.ID), token) {
		t.Fatal("token leaked into job output or logs")
	}
}

func TestEmailWithoutMailerFailsClosed(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	ver := r.publish(t, emailYAML)
	r.bind(t, ver.ID, emailPins()...)
	exec := r.start(t, ver)
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	step := r.onlyStep(t, exec.ID)
	if r.onlyJob(t, exec.ID).Status != wfstore.JobFailed || step.Error["code"] != httpnotify.CodeDeliveryFailed {
		t.Fatalf("email %v", step.Error)
	}
	msg, _ := step.Error["message"].(string)
	if strings.Contains(msg, localMsg) {
		t.Fatal(msg)
	}
}

func TestDraftBindingNeverDispatches(t *testing.T) {
	called := false
	disp := &Dispatcher{Engines: Engines{Kube: func(*kubernetes.Handle) (kubernetes.ClusterClient, error) {
		called = true
		return nil, errors.New("called")
	}}}
	scope, err := isolation.Authorize(wsID, actorID)
	if err != nil {
		t.Fatal(err)
	}
	job := Job{
		Binding:   wfstore.JobBinding{WorkspaceID: wsID, JobID: actorID, ExecutionID: targetID, ExpiresAt: time.Now().Add(time.Minute)},
		Step:      wfstore.ExecutionStep{NodeType: "kubernetes.apply", Input: map[string]any{"clusterTargetId": targetID}},
		Execution: wfstore.Execution{},
		Job:       wfstore.ExecutionJob{Status: wfstore.JobRunning},
	}
	decision := disp.Execute(context.Background(), scope, authz.ExpandRoles([]string{authz.RoleOperator}), job)
	if !decision.Fail || decision.Error["code"] != CodeDraftNotRunnable {
		t.Fatalf("decision %+v", decision)
	}
	if called {
		t.Fatal("engine called for a draft binding")
	}

	var failed map[string]any
	q := &scriptedQueue{job: &job, fail: func(err map[string]any) { failed = err }}
	buf := &bytes.Buffer{}
	loop := NewRunner(q, disp, Config{WorkerID: "production-runner", Log: slog.New(slog.NewJSONHandler(buf, nil))})
	if _, err := loop.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if failed["code"] != CodeDraftNotRunnable || q.heartbeats != 0 || called {
		t.Fatalf("fail=%v heartbeats=%d called=%v", failed, q.heartbeats, called)
	}
	if strings.Contains(buf.String(), localMsg) {
		t.Fatal(buf.String())
	}
}

type rig struct {
	t       *testing.T
	scope   isolation.Scope
	wf      *wfstore.Memory
	ops     *opsconfig.Memory
	vault   *vault.Memory
	scripts *scripts.Memory
	sign    []byte
	log     *bytes.Buffer
	queue   *StoreQueue
	disp    *Dispatcher
	loop    *Runner
}

func newRig(t *testing.T, perms []string) (*rig, *kubernetes.FakeClient) {
	t.Helper()
	scope, err := isolation.Authorize(wsID, actorID)
	if err != nil {
		t.Fatal(err)
	}
	fake := kubernetes.NewFakeClient()
	buf := &bytes.Buffer{}
	r := &rig{
		t:       t,
		scope:   scope,
		wf:      wfstore.NewMemory(),
		ops:     opsconfig.NewMemory(),
		vault:   vault.NewMemory(vault.TestKeys(), nil),
		scripts: scripts.NewMemory(),
		sign:    scripts.NewSigningKey(),
		log:     buf,
	}
	r.queue = &StoreQueue{
		Workflows: r.wf,
		JobKey:    wfstore.NewJobBindingKey(),
		WorkerID:  "production-runner",
		Lease:     30 * time.Second,
		Now:       func() time.Time { return time.Now().UTC().Add(time.Second) },
		Fixed: []Workspace{{
			ID:          wsID,
			ActorID:     actorID,
			Permissions: perms,
		}},
	}
	r.disp = &Dispatcher{
		Ops:       r.ops,
		Vault:     r.vault,
		Scripts:   r.scripts,
		ScriptKey: r.sign,
		Engines: Engines{Kube: func(h *kubernetes.Handle) (kubernetes.ClusterClient, error) {
			if h == nil {
				return nil, errors.New("missing handle")
			}
			return fake, nil
		}},
	}
	r.loop = NewRunner(r.queue, r.disp, Config{
		WorkerID: "production-runner",
		Log:      slog.New(slog.NewJSONHandler(buf, nil)),
	})
	return r, fake
}

func (r *rig) publish(t *testing.T, src string) wfstore.Version {
	t.Helper()
	normalized, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("yaml: %v", errs)
	}
	wf, _, err := r.wf.Create(context.Background(), r.scope, wfstore.CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := r.wf.Publish(context.Background(), r.scope, wf.ID, wfstore.PublishInput{ExpectedRevision: 1, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	return ver
}

func (r *rig) start(t *testing.T, ver wfstore.Version) wfstore.Execution {
	t.Helper()
	exec, err := r.wf.StartExecution(context.Background(), r.scope, ver.WorkflowID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return exec
}

func (r *rig) bind(t *testing.T, versionID string, pins ...opsconfig.Pin) {
	t.Helper()
	if _, err := r.ops.BindPins(context.Background(), r.scope, opsconfig.BindInput{
		OwnerKind: opsconfig.OwnerWorkflowVersion,
		OwnerID:   versionID,
		Pins:      pins,
	}); err != nil {
		t.Fatal(err)
	}
}

func (r *rig) kubeCred(t *testing.T) string {
	t.Helper()
	return r.secret(t, vault.TypeKubernetes, map[string]string{"kubeconfig": kubeconfigFixture})
}

func (r *rig) secret(t *testing.T, typ string, secret map[string]string) string {
	t.Helper()
	meta, err := r.vault.Create(context.Background(), r.scope, vault.CreateInput{
		Type:        typ,
		DisplayName: typ,
		Secret:      secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	return meta.ID
}

func (r *rig) publishScript(t *testing.T, source string) scripts.Artifact {
	t.Helper()
	art, err := (&scripts.Pipeline{Store: r.scripts, Key: r.sign}).Publish(context.Background(), r.scope, scripts.PublishInput{
		Language:             scripts.LanguagePython,
		Source:               source,
		Entrypoint:           "main.py",
		RuntimeProfileID:     rtID,
		RuntimeProfileDigest: "sha256:" + strings.Repeat("c", 64),
		RuntimeProfile:       runtimeSpec(),
		TimeoutSeconds:       30,
		InputSchema:          map[string]any{"type": "object", "additionalProperties": false},
		OutputSchema:         map[string]any{"type": "object"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return art
}

func (r *rig) onlyJob(t *testing.T, executionID string) wfstore.ExecutionJob {
	t.Helper()
	jobs, err := r.wf.ListJobs(context.Background(), r.scope, executionID)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs %v %v", jobs, err)
	}
	return jobs[0]
}

func (r *rig) onlyStep(t *testing.T, executionID string) wfstore.ExecutionStep {
	t.Helper()
	steps, err := r.wf.ListSteps(context.Background(), r.scope, executionID)
	if err != nil || len(steps) != 1 {
		t.Fatalf("steps %v %v", steps, err)
	}
	return steps[0]
}

func (r *rig) trace(t *testing.T, executionID string) string {
	t.Helper()
	step := r.onlyStep(t, executionID)
	raw, err := json.Marshal(map[string]any{"output": step.Output, "error": step.Error, "log": r.log.String()})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

type panicRuntime struct{ called bool }

func (p *panicRuntime) Name() string { return scripts.IsolationModeHarness }
func (p *panicRuntime) Run(context.Context, scripts.IsolationSpec, scripts.IsolatedJob) (scripts.IsolatedResult, error) {
	p.called = true
	return scripts.IsolatedResult{}, errors.New("yaml source must not run")
}

type fakeSSH struct{ signer bool }

func (f *fakeSSH) Connect(_ context.Context, cfg ssh.ConnectConfig) (ssh.Session, error) {
	if cfg.Signer == nil {
		return nil, errors.New("missing signer")
	}
	f.signer = true
	return okSession{}, nil
}

type okSession struct{}

func (okSession) Run(context.Context, string) (string, string, int, error) {
	return "ok", "", 0, nil
}
func (okSession) Close() error { return nil }

type fakeRT struct{}

func (fakeRT) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		Header:     make(http.Header),
		Request:    req,
	}, nil
}

type scriptedQueue struct {
	job        *Job
	heartbeats int
	fail       func(map[string]any)
}

func (q *scriptedQueue) Workspaces(context.Context) ([]Workspace, error) {
	return []Workspace{{ID: wsID, ActorID: actorID}}, nil
}
func (q *scriptedQueue) Claim(context.Context, Workspace) (*Job, error) {
	job := q.job
	q.job = nil
	return job, nil
}
func (q *scriptedQueue) Heartbeat(context.Context, Workspace, Job) error {
	q.heartbeats++
	return nil
}
func (q *scriptedQueue) Complete(context.Context, Workspace, Job, map[string]any) error { return nil }
func (q *scriptedQueue) Fail(_ context.Context, _ Workspace, _ Job, failure map[string]any) error {
	q.fail(failure)
	return nil
}
func (q *scriptedQueue) Park(context.Context, Workspace, Job, time.Time) error { return nil }

func clusterPin(cred string) opsconfig.Pin {
	return opsconfig.Pin{
		Kind: opsconfig.KindClusterTarget, ResourceID: targetID, VersionID: targetID, VersionNumber: 1,
		Digest: "sha256:" + strings.Repeat("a", 64),
		Spec: map[string]any{
			"credentialId":      cred,
			"endpoint":          map[string]any{"apiServer": "https://kube.example"},
			"allowedNamespaces": []any{"cp-ops-nprd"},
		},
	}
}

func runtimePin() opsconfig.Pin {
	return opsconfig.Pin{
		Kind: opsconfig.KindRuntimeProfile, ResourceID: rtID, VersionID: rtID, VersionNumber: 1,
		Digest: "sha256:" + strings.Repeat("c", 64),
		Spec:   runtimeSpec(),
	}
}

func runtimeSpec() map[string]any {
	return map[string]any{
		"language":             "python",
		"imageDigest":          "sha256:" + strings.Repeat("a", 64),
		"dependencyLockDigest": "sha256:" + strings.Repeat("b", 64),
		"limits":               map[string]any{"cpuMillis": 250, "memoryMib": 256, "timeoutSeconds": 30, "processes": 32},
	}
}

func sshTargetPin(cred string) opsconfig.Pin {
	return opsconfig.Pin{
		Kind: opsconfig.KindSSHTarget, ResourceID: sshID, VersionID: sshID, VersionNumber: 1,
		Digest: "sha256:" + strings.Repeat("e", 64),
		Spec: map[string]any{
			"hostname":           "203.0.113.10",
			"username":           "ops",
			"credentialId":       cred,
			"hostKeyFingerprint": "sha256:" + strings.Repeat("ab", 32),
		},
	}
}

func commandPin() opsconfig.Pin {
	return opsconfig.Pin{
		Kind: opsconfig.KindCommandProfile, ResourceID: profID, VersionID: profID, VersionNumber: 1,
		Digest: "sha256:" + strings.Repeat("f", 64),
		Spec: map[string]any{
			"template": "echo ok",
			"parameterSchema": map[string]any{
				"type":                 "object",
				"additionalProperties": false,
				"properties":           map[string]any{},
			},
		},
	}
}

func httpPin(cred string) opsconfig.Pin {
	return opsconfig.Pin{
		Kind: opsconfig.KindConnection, ResourceID: connID, VersionID: connID, VersionNumber: 1,
		Digest: "sha256:" + strings.Repeat("1", 64),
		Spec: map[string]any{
			"type":         "http",
			"credentialId": cred,
			"endpointPolicy": map[string]any{
				"hosts":            []any{"203.0.113.10"},
				"methods":          []any{"GET"},
				"pathPrefixes":     []any{"/"},
				"tlsRequired":      false,
				"ports":            []any{80},
				"allowedAddresses": []any{"203.0.113.10"},
			},
		},
	}
}

func emailPins() []opsconfig.Pin {
	return []opsconfig.Pin{
		{
			Kind: opsconfig.KindConnection, ResourceID: connID, VersionID: connID, VersionNumber: 1,
			Digest: "sha256:" + strings.Repeat("2", 64),
			Spec:   map[string]any{"type": "smtp"},
		},
		{
			Kind: opsconfig.KindRecipientList, ResourceID: listID, VersionID: listID, VersionNumber: 1,
			Digest: "sha256:" + strings.Repeat("3", 64),
			Spec: map[string]any{"recipientPolicy": map[string]any{
				"emails":  []any{"ops@example.com"},
				"domains": []any{"example.com"},
			}},
		},
		{
			Kind: opsconfig.KindMessageTemplate, ResourceID: tmplID, VersionID: tmplID, VersionNumber: 1,
			Digest: "sha256:" + strings.Repeat("4", 64),
			Spec: map[string]any{
				"subject":     "Alert",
				"body":        "ok",
				"inputSchema": map[string]any{"type": "object", "additionalProperties": false},
			},
		},
	}
}

func ed25519PEM(t *testing.T) string {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := cryptossh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(block))
}

func coreYAML(id, typ, with string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ` + id + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: ` + id + `
      type: ` + typ + `
      name: ` + id + `
      with:
        ` + with + `
  edges: []
`
}

func scriptYAML(source string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: script
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: script.python
      name: Run
      with:
        source: |
          ` + strings.ReplaceAll(strings.TrimRight(source, "\n"), "\n", "\n          ") + `
        entrypoint: main.py
        runtimeProfileId: ` + rtID + `
        timeoutSeconds: 30
        inputSchema:
          type: object
          additionalProperties: false
        outputSchema:
          type: object
  edges: []
`
}

const k8sYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: apply-config
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: apply
      type: kubernetes.apply
      name: Apply
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        manifests: |
          apiVersion: v1
          kind: ConfigMap
          metadata:
            name: cfg
            namespace: cp-ops-nprd
          data:
            app: ready
  edges: []
`

const sshYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ssh
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: ssh.run
      name: Run
      with:
        sshTargetId: 33333333-3333-4333-8333-333333333333
        commandProfileId: 55555555-5555-4555-8555-555555555555
  edges: []
`

const httpYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: http
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: call
      type: http.request
      name: Call
      with:
        connectionId: 77777777-7777-4777-8777-777777777777
        method: GET
        path: /
        host: 203.0.113.10
  edges: []
`

const emailYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: email
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: mail
      type: notification.email
      name: Mail
      with:
        connectionId: 77777777-7777-4777-8777-777777777777
        recipientListId: 88888888-8888-4888-8888-888888888888
        templateId: 99999999-9999-4999-8999-999999999999
  edges: []
`

const kubeconfigFixture = "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://127.0.0.1\n    certificate-authority-data: QQ==\ncontexts:\n- name: ctx\n  context:\n    cluster: c\n    user: u\ncurrent-context: ctx\nusers:\n- name: u\n  user:\n    token: very-secret-token\n"
