package scripts

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmbeddedTemplateMatchesDeployManifest(t *testing.T) {
	root := findRepoRoot(t)
	body, err := os.ReadFile(filepath.Join(root, "deploy/kubernetes/script-runner-deployment.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body, embeddedScriptJobTemplate) {
		t.Fatal("embedded script job template drifted from deploy/kubernetes/script-runner-deployment.yaml")
	}
	if !bytes.Contains(body, []byte("kind: Job")) || bytes.Contains(body, []byte("replicas:")) {
		t.Fatal("template must be a Job without replicas")
	}
	if !bytes.Contains(body, []byte(ScriptRunnerImageRef)) {
		t.Fatalf("template image %s missing", ScriptRunnerImageRef)
	}
}

func TestRenderScriptJobPinsImageAndDropsSecrets(t *testing.T) {
	const leak = "-----BEGIN RSA PRIVATE KEY-----\nMIIB"
	spec, err := IsolationFromProfile(LanguagePython, approvedPythonProfile(), NodeLimits{})
	if err != nil {
		t.Fatal(err)
	}
	job := IsolatedJob{
		Language:   LanguagePython,
		Entrypoint: "main.py",
		Source:     "import json\nprint(json.dumps({\"status\": \"ok\"}))\n",
		Image:      spec.ImageDigest,
		Env: map[string]string{
			"FLOWFORGE_CORRELATION_ID": "corr-1",
			"TOKEN":                    "super-secret-token-value",
			"KUBECONFIG":               "apiVersion: v1",
		},
	}
	manifest, err := RenderScriptJob(EmbeddedScriptJobTemplate(), "flowforge", spec, job)
	if err != nil {
		t.Fatal(err)
	}
	raw := mustJSON(manifest)
	if strings.Contains(raw, leak) || strings.Contains(raw, "super-secret-token-value") || strings.Contains(raw, "KUBECONFIG") {
		t.Fatalf("secret leaked: %s", raw)
	}
	if manifest["kind"] != "Job" {
		t.Fatalf("kind %v", manifest["kind"])
	}
	if walkHas(manifest, "replicas") {
		t.Fatal("replicas set")
	}
	container, err := runnerContainer(mustMap(mustMap(mustMap(manifest, "spec"), "template"), "spec"))
	if err != nil {
		t.Fatal(err)
	}
	image, _ := container["image"].(string)
	want := ScriptRunnerRepository + "@" + spec.ImageDigest
	if image != want {
		t.Fatalf("image %s", image)
	}
	if envValue(container, "FLOWFORGE_SCRIPT_SOURCE") != job.Source {
		t.Fatal("published source missing from the Job")
	}
	if envValue(container, "TOKEN") != "" || envValue(container, "KUBECONFIG") != "" {
		t.Fatal("denied env copied onto the Job")
	}
	pod := mustMap(mustMap(mustMap(manifest, "spec"), "template"), "spec")
	if pod["automountServiceAccountToken"] != false || pod["restartPolicy"] != "Never" {
		t.Fatalf("pod spec %+v", pod)
	}
	if _, err := RenderScriptJob(EmbeddedScriptJobTemplate(), "flowforge", spec, IsolatedJob{
		Language: LanguagePython, Entrypoint: "main.py", Source: leak,
	}); err == nil || asEngineError(err).Code != CodeSecretForbidden {
		t.Fatalf("secret source: %v", err)
	}
}

func TestExecuteDraftDoesNotSubmitJob(t *testing.T) {
	art, key, profile := publishedPython(t)
	art.Status = StatusDraft
	sub := &recordingSubmitter{stdout: `{"status":"ok"}`}
	out := Execute(context.Background(), Request{
		Artifact:           art,
		Source:             validPythonInput().Source,
		Language:           LanguagePython,
		Entrypoint:         "main.py",
		SigningKey:         key,
		RuntimeProfile:     profile,
		Permissions:        operatorPerms(),
		Runtime:            KubernetesJobRuntime{Template: EmbeddedScriptJobTemplate(), Namespace: "flowforge", Submitter: sub},
		RequireLiveRuntime: true,
	})
	if sub.n != 0 {
		t.Fatal("draft submitted a Job")
	}
	if out.OK || out.Error == nil || out.Error.Code != CodeArtifactMutable {
		t.Fatalf("%+v", out)
	}
}

func TestExecuteLiveJobUsesTemplate(t *testing.T) {
	art, key, profile := publishedPython(t)
	sub := &recordingSubmitter{stdout: `{"status":"ok","runtime":"kubernetes"}`}
	out := Execute(context.Background(), Request{
		Artifact:           art,
		Source:             validPythonInput().Source,
		Language:           LanguagePython,
		Entrypoint:         "main.py",
		SigningKey:         key,
		RuntimeProfile:     profile,
		Permissions:        operatorPerms(),
		Runtime:            KubernetesJobRuntime{Template: EmbeddedScriptJobTemplate(), Namespace: "flowforge", Submitter: sub},
		RequireLiveRuntime: true,
	})
	if !out.OK || out.Error != nil {
		t.Fatalf("%+v", out)
	}
	if sub.n != 1 || sub.manifest["kind"] != "Job" {
		t.Fatalf("submits %d kind %v", sub.n, sub.manifest["kind"])
	}
	if out.Isolation.Mode != IsolationModeLive {
		t.Fatalf("mode %s", out.Isolation.Mode)
	}
}

func TestAPIJobClientCreateAndHidesToken(t *testing.T) {
	const token = "script-runner-api-token-value"
	var posted []byte
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/jobs"):
			auth = r.Header.Get("Authorization")
			posted, _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"kind":"Job"}`))
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/pods/") && strings.HasSuffix(r.URL.Path, "/log"):
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/pods"):
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"ff-pod-1"}}]}`))
		case r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"status":{"succeeded":1}}`))
		default:
			http.Error(w, token, http.StatusForbidden)
		}
	}))
	defer srv.Close()
	client, err := newAPIJobClient(APIJobConfig{
		Host: srv.URL, Token: token, Namespace: "flowforge", PollEvery: 1,
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := IsolationFromProfile(LanguagePython, approvedPythonProfile(), NodeLimits{})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := RenderScriptJob(EmbeddedScriptJobTemplate(), "flowforge", spec, IsolatedJob{
		Language: LanguagePython, Entrypoint: "main.py",
		Source: "import json\nprint(json.dumps({\"status\": \"ok\"}))\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Submit(context.Background(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Stdout != `{"status":"ok"}` {
		t.Fatalf("%+v", res)
	}
	if auth != "Bearer "+token {
		t.Fatal("missing bearer")
	}
	if bytes.Contains(posted, []byte(token)) {
		t.Fatal("token posted in the Job body")
	}
	if !bytes.Contains(posted, []byte(ScriptRunnerRepository+"@"+spec.ImageDigest)) {
		t.Fatalf("posted image missing: %s", posted)
	}

	deny := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, token, http.StatusForbidden)
	}))
	defer deny.Close()
	denied, err := newAPIJobClient(APIJobConfig{Host: deny.URL, Token: token, Namespace: "flowforge"}, true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = denied.Submit(context.Background(), manifest)
	if err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("error leaked token: %v", err)
	}
}

func TestAPIJobClientRereadsTokenFile(t *testing.T) {
	const first = "script-runner-token-aaaa"
	const second = "script-runner-token-bbbb"
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			got = append(got, r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"kind":"Job"}`))
			return
		}
		if strings.Contains(r.URL.Path, "/log") {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		if strings.Contains(r.URL.Path, "/pods") {
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"ff-pod-1"}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":{"succeeded":1}}`))
	}))
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := newAPIJobClient(APIJobConfig{
		Host: srv.URL, TokenFile: path, Namespace: "flowforge", PollEvery: 1,
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := IsolationFromProfile(LanguagePython, approvedPythonProfile(), NodeLimits{})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := RenderScriptJob(EmbeddedScriptJobTemplate(), "flowforge", spec, IsolatedJob{
		Language: LanguagePython, Entrypoint: "main.py", Source: "print('ok')\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Submit(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(second), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest2, err := RenderScriptJob(EmbeddedScriptJobTemplate(), "flowforge", spec, IsolatedJob{
		Language: LanguagePython, Entrypoint: "main.py", Source: "print('ok')\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Submit(context.Background(), manifest2); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "Bearer "+first || got[1] != "Bearer "+second {
		t.Fatalf("auth %v", got)
	}
	if strings.Contains(strings.Join(got, " "), "print('ok')") {
		t.Fatal(got)
	}
}

func TestAPIJobClientRejectsHTTP(t *testing.T) {
	_, err := NewAPIJobClient(APIJobConfig{Host: "http://kubernetes.default.svc", Token: "script-runner-api-token-value", Namespace: "flowforge"})
	if err == nil {
		t.Fatal("expected https requirement")
	}
}

type recordingSubmitter struct {
	n        int
	manifest map[string]any
	stdout   string
}

func envValue(container map[string]any, name string) string {
	env, _ := container["env"].([]any)
	for _, item := range env {
		m, _ := item.(map[string]any)
		if m["name"] == name {
			s, _ := m["value"].(string)
			return s
		}
	}
	return ""
}

func (r *recordingSubmitter) Submit(_ context.Context, manifest map[string]any) (IsolatedResult, error) {
	r.n++
	raw, err := json.Marshal(manifest)
	if err != nil {
		return IsolatedResult{}, err
	}
	var clone map[string]any
	if err := json.Unmarshal(raw, &clone); err != nil {
		return IsolatedResult{}, err
	}
	r.manifest = clone
	return IsolatedResult{OK: true, ExitCode: 0, Stdout: r.stdout}, nil
}
