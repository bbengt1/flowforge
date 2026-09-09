package kubernetes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func pinnedImage() string {
	return "registry.example.com/api@sha256:" + strings.Repeat("a", 64)
}

func policyWatch() PolicyContext {
	p := policyNS()
	p.Verbs = []string{"apply", "get", "list", "watch"}
	p.Kinds = []string{"ConfigMap", "Service", "Deployment", "StatefulSet", "DaemonSet", "Job", "Ingress"}
	return p
}

func deploymentYAML() string {
	return "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: cp-ops-nprd\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: api\n  template:\n    metadata:\n      labels:\n        app: api\n    spec:\n      containers:\n      - name: api\n        image: " + pinnedImage() + "\n"
}

func jobYAML() string {
	return "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: batch\n  namespace: cp-ops-nprd\nspec:\n  completions: 1\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: batch\n        image: " + pinnedImage() + "\n"
}

func readyDeployment(name string, gen int64, replicas int64) Unstructured {
	return Unstructured{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata":   map[string]any{"name": name, "namespace": "cp-ops-nprd", "generation": gen},
		"spec":       map[string]any{"replicas": replicas},
		"status": map[string]any{
			"observedGeneration":  gen,
			"replicas":            replicas,
			"updatedReplicas":     replicas,
			"readyReplicas":       replicas,
			"availableReplicas":   replicas,
			"unavailableReplicas": 0,
			"conditions": []any{
				map[string]any{"type": "Available", "status": "True"},
			},
		},
	}
}

func watchReq(client ClusterClient, kind, name string) Request {
	return Request{
		Operation:       "kubernetes.rolloutStatus",
		ClusterTargetID: "11111111-1111-4111-8111-111111111111",
		Namespace:       "cp-ops-nprd",
		Kind:            kind,
		Name:            name,
		Wait:            "ready",
		TimeoutSeconds:  5,
		Permissions:     operatorPerms(),
		Policy:          policyWatch(),
		Target:          targetNS(),
		Client:          client,
		CorrelationID:   "corr-watch",
		ActorID:         "user-1",
	}
}

func TestEvaluateRolloutKinds(t *testing.T) {
	t.Run("deployment ready", func(t *testing.T) {
		p := EvaluateRollout(readyDeployment("api", 3, 2))
		if p.State != ObservationReady || p.ObservedGeneration != 3 || p.ReadyReplicas != 2 {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("deployment progress deadline", func(t *testing.T) {
		obj := readyDeployment("api", 2, 2)
		obj["status"] = map[string]any{
			"observedGeneration": 1,
			"conditions": []any{
				map[string]any{"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded"},
			},
		}
		p := EvaluateRollout(obj)
		if p.State != ObservationFailed || p.Reason != "progress-deadline-exceeded" {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("statefulset ready", func(t *testing.T) {
		p := EvaluateRollout(Unstructured{
			"apiVersion": "apps/v1", "kind": "StatefulSet",
			"metadata": map[string]any{"name": "db", "namespace": "cp-ops-nprd", "generation": 1},
			"spec":     map[string]any{"replicas": 3},
			"status":   map[string]any{"observedGeneration": 1, "readyReplicas": 3, "updatedReplicas": 3},
		})
		if p.State != ObservationReady || p.ReadyReplicas != 3 {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("daemonset ready", func(t *testing.T) {
		p := EvaluateRollout(Unstructured{
			"apiVersion": "apps/v1", "kind": "DaemonSet",
			"metadata": map[string]any{"name": "agent", "namespace": "cp-ops-nprd", "generation": 1},
			"status": map[string]any{
				"observedGeneration": 1, "desiredNumberScheduled": 4,
				"updatedNumberScheduled": 4, "numberAvailable": 4,
			},
		})
		if p.State != ObservationReady || p.NumberAvailable != 4 {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("job complete", func(t *testing.T) {
		p := EvaluateRollout(Unstructured{
			"apiVersion": "batch/v1", "kind": "Job",
			"metadata": map[string]any{"name": "batch", "namespace": "cp-ops-nprd"},
			"spec":     map[string]any{"completions": 1},
			"status": map[string]any{
				"succeeded":  1,
				"conditions": []any{map[string]any{"type": "Complete", "status": "True"}},
			},
		})
		if p.State != ObservationReady {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("job failed", func(t *testing.T) {
		p := EvaluateRollout(Unstructured{
			"apiVersion": "batch/v1", "kind": "Job",
			"metadata": map[string]any{"name": "batch", "namespace": "cp-ops-nprd"},
			"status": map[string]any{
				"failed":     1,
				"conditions": []any{map[string]any{"type": "Failed", "status": "True", "reason": "BackoffLimitExceeded"}},
			},
		})
		if p.State != ObservationFailed || p.Reason != "job-failed" {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("configmap skipped", func(t *testing.T) {
		p := EvaluateRollout(Unstructured{
			"apiVersion": "v1", "kind": "ConfigMap",
			"metadata": map[string]any{"name": "cfg", "namespace": "cp-ops-nprd"},
		})
		if p.State != ObservationSkipped {
			t.Fatalf("%+v", p)
		}
	})
}

func TestRolloutStatusSuccess(t *testing.T) {
	fake := NewFakeClient()
	fake.Seed(readyDeployment("api", 2, 2), FieldManager)
	res := Execute(context.Background(), watchReq(fake, "Deployment", "api"))
	if !res.OK || res.Observation != ObservationReady || res.Error != nil {
		t.Fatalf("watch: %+v", res)
	}
	if fake.Watches < 1 {
		t.Fatal("expected watch verb")
	}
	if res.Audit["actorId"] != "user-1" || res.Audit["watch"] != ObservationReady || res.Audit["correlationId"] != "corr-watch" {
		t.Fatalf("audit = %+v", res.Audit)
	}
	progress, _ := res.Status["progress"].([]map[string]any)
	if len(progress) != 1 || progress[0]["state"] != ObservationReady {
		t.Fatalf("progress = %+v", res.Status)
	}
}

func TestRolloutStatusResourceInput(t *testing.T) {
	fake := NewFakeClient()
	fake.Seed(readyDeployment("api", 1, 1), FieldManager)
	req := watchReq(fake, "", "")
	req.Resource = map[string]any{"kind": "Deployment", "name": "api"}
	res := Execute(context.Background(), req)
	if !res.OK || res.Observation != ObservationReady {
		t.Fatalf("%+v", res)
	}
}

func TestRolloutStatusJobFailure(t *testing.T) {
	fake := NewFakeClient()
	fake.Seed(Unstructured{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": map[string]any{"name": "batch", "namespace": "cp-ops-nprd"},
		"status": map[string]any{
			"failed":     1,
			"conditions": []any{map[string]any{"type": "Failed", "status": "True"}},
		},
	}, FieldManager)
	res := Execute(context.Background(), watchReq(fake, "Job", "batch"))
	if res.OK || res.Error == nil || res.Error.Code != CodeRolloutFailed {
		t.Fatalf("job fail: %+v", res)
	}
	if res.Observation != ObservationFailed {
		t.Fatalf("observation = %s", res.Observation)
	}
	if !fake.Has("Job", "cp-ops-nprd", "batch") {
		t.Fatal("job was deleted after failure")
	}
}

func TestRolloutStatusTimeoutLeavesResource(t *testing.T) {
	fake := NewFakeClient()
	fake.Seed(Unstructured{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": "api", "namespace": "cp-ops-nprd", "generation": int64(2)},
		"spec":     map[string]any{"replicas": 2},
	}, FieldManager)
	req := watchReq(fake, "Deployment", "api")
	req.TimeoutSeconds = 1
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeTimeout {
		t.Fatalf("timeout: %+v", res)
	}
	if res.Observation != ObservationTimeout {
		t.Fatalf("observation = %s", res.Observation)
	}
	if !fake.Has("Deployment", "cp-ops-nprd", "api") {
		t.Fatal("timeout deleted the resource")
	}
}

func TestRolloutStatusCancelLeavesResource(t *testing.T) {
	fake := NewFakeClient()
	fake.Seed(Unstructured{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": "api", "namespace": "cp-ops-nprd", "generation": int64(1)},
		"spec":     map[string]any{"replicas": 1},
	}, FieldManager)
	ctx, cancel := context.WithCancel(context.Background())
	req := watchReq(fake, "Deployment", "api")
	req.TimeoutSeconds = 30
	done := make(chan Result, 1)
	go func() { done <- Execute(ctx, req) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	res := <-done
	if res.OK || res.Error == nil || res.Error.Code != CodeCanceled {
		t.Fatalf("cancel: %+v", res)
	}
	if res.Observation != ObservationCanceled {
		t.Fatalf("observation = %s", res.Observation)
	}
	if !fake.Has("Deployment", "cp-ops-nprd", "api") {
		t.Fatal("cancel deleted the resource")
	}
}

func TestRolloutStatusPolicyAndRBACDenial(t *testing.T) {
	t.Run("verb denied", func(t *testing.T) {
		fake := NewFakeClient()
		fake.Seed(readyDeployment("api", 1, 1), FieldManager)
		req := watchReq(fake, "Deployment", "api")
		req.Policy.Verbs = []string{"get", "list", "apply"}
		req.Policy.VerbsPresent = true
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeVerbDenied {
			t.Fatalf("verb: %+v", res.Error)
		}
		if fake.Watches != 0 {
			t.Fatal("watch reached cluster after policy deny")
		}
	})
	t.Run("kind denied", func(t *testing.T) {
		fake := NewFakeClient()
		req := watchReq(fake, "ConfigMap", "cfg")
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodeKindDenied {
			t.Fatalf("kind: %+v", res.Error)
		}
	})
	t.Run("rbac watch", func(t *testing.T) {
		fake := NewFakeClient()
		fake.Seed(readyDeployment("api", 1, 1), FieldManager)
		fake.Deny = func(verb, kind, namespace, name string) error {
			if verb == "watch" {
				return engineError(CodeRBACDenied, "RoleBinding does not allow watch", http.StatusForbidden)
			}
			return nil
		}
		res := Execute(context.Background(), watchReq(fake, "Deployment", "api"))
		if res.OK || res.Error == nil || res.Error.Code != CodeRBACDenied {
			t.Fatalf("rbac: %+v", res.Error)
		}
	})
	t.Run("flowforge permission", func(t *testing.T) {
		fake := NewFakeClient()
		req := watchReq(fake, "Deployment", "api")
		req.Permissions = authz.ExpandRoles([]string{authz.RoleViewer})
		res := Execute(context.Background(), req)
		if res.OK || res.Error == nil || res.Error.Code != CodePermissionDenied {
			t.Fatalf("perm: %+v", res.Error)
		}
	})
}

func TestApplyWaitReadyObservesDeployment(t *testing.T) {
	fake := NewFakeClient()
	fake.ReadyAfterApply = true
	req := baseApplyReq(fake)
	req.Manifests = deploymentYAML()
	req.Wait = "ready"
	req.Policy = policyWatch()
	req.ActorID = "user-1"
	res := Execute(context.Background(), req)
	if !res.OK || res.Error != nil {
		t.Fatalf("apply wait: %+v", res.Error)
	}
	if res.Observation != ObservationReady {
		t.Fatalf("observation = %s status=%+v", res.Observation, res.Status)
	}
	if !res.Applied || fake.Applies != 1 || fake.Watches < 1 {
		t.Fatalf("counts apply=%d watch=%d", fake.Applies, fake.Watches)
	}
	if res.Audit["applied"] != true || res.Audit["watch"] != ObservationReady || res.Audit["actorId"] != "user-1" {
		t.Fatalf("audit = %+v", res.Audit)
	}
}

func TestApplyWaitReadyJobFailureDoesNotRollback(t *testing.T) {
	fake := NewFakeClient()
	req := baseApplyReq(fake)
	req.Manifests = jobYAML()
	req.Wait = "ready"
	req.Policy = policyWatch()
	req.TimeoutSeconds = 5
	// Persist a failed Job status after apply by racing SetStatus.
	go func() {
		for i := 0; i < 50 && fake.Applies == 0; i++ {
			time.Sleep(10 * time.Millisecond)
		}
		fake.SetStatus("Job", "cp-ops-nprd", "batch", map[string]any{
			"failed": 1,
			"conditions": []any{
				map[string]any{"type": "Failed", "status": "True"},
			},
		})
	}()
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeRolloutFailed {
		t.Fatalf("job apply wait: %+v", res)
	}
	if !res.Applied || !fake.Has("Job", "cp-ops-nprd", "batch") {
		t.Fatal("failed job was rolled back")
	}
}

func TestApplyWaitReadyRequiresWatchVerb(t *testing.T) {
	fake := NewFakeClient()
	req := baseApplyReq(fake)
	req.Manifests = deploymentYAML()
	req.Wait = "ready"
	// policyNS has apply/get/list only
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeVerbDenied {
		t.Fatalf("watch verb: %+v", res.Error)
	}
	if fake.DryRuns != 0 || fake.Applies != 0 {
		t.Fatal("cluster contacted before watch policy check")
	}
}

func TestApplyWaitReadyTimeoutDoesNotDelete(t *testing.T) {
	fake := NewFakeClient()
	req := baseApplyReq(fake)
	req.Manifests = deploymentYAML()
	req.Wait = "ready"
	req.Policy = policyWatch()
	req.TimeoutSeconds = 1
	res := Execute(context.Background(), req)
	if res.OK || res.Error == nil || res.Error.Code != CodeTimeout {
		t.Fatalf("timeout: %+v", res)
	}
	if !res.Applied || !fake.Has("Deployment", "cp-ops-nprd", "api") {
		t.Fatal("timeout deleted applied deployment")
	}
	if res.Observation != ObservationTimeout {
		t.Fatalf("observation = %s", res.Observation)
	}
}

func TestObservationOutputsRedactSecrets(t *testing.T) {
	fake := NewFakeClient()
	obj := readyDeployment("api", 1, 1)
	obj["kubeconfig"] = "apiVersion: v1\nkind: Config\n"
	obj["status"].(map[string]any)["token"] = "super-secret"
	fake.Seed(obj, FieldManager)
	req := watchReq(fake, "Deployment", "api")
	res := Execute(context.Background(), req)
	raw, _ := json.Marshal(res)
	if strings.Contains(string(raw), "super-secret") || strings.Contains(string(raw), "kind: Config") {
		t.Fatalf("leaked: %s", raw)
	}
	if res.Audit["watch"] != ObservationReady {
		t.Fatalf("audit = %+v", res.Audit)
	}
}

func TestCatalogDocumentsObservation(t *testing.T) {
	cat := Catalog()
	if cat.Apply.WaitReady != WaitReadyObserved || cat.Observation.WaitReady != WaitReadyObserved {
		t.Fatalf("waitReady still deferred: %+v", cat.Apply)
	}
	if cat.Observation.Verb != "watch" || !cat.Observation.NeverMutates {
		t.Fatalf("observation catalog = %+v", cat.Observation)
	}
	found := false
	for _, n := range cat.Nodes {
		if n.Type == "kubernetes.rolloutStatus" {
			found = true
			if n.Verb != "watch" || n.WaitReady != WaitReadyObserved {
				t.Fatalf("node = %+v", n)
			}
		}
		if n.Type == "kubernetes.apply" && n.WaitReady != WaitReadyObserved {
			t.Fatalf("apply waitReady = %s", n.WaitReady)
		}
	}
	if !found {
		t.Fatal("catalog missing kubernetes.rolloutStatus")
	}
	var canceled, rollout bool
	for _, e := range cat.Errors {
		if e.Code == CodeCanceled {
			canceled = true
		}
		if e.Code == CodeRolloutFailed {
			rollout = true
		}
	}
	if !canceled || !rollout {
		t.Fatalf("error catalog missing codes: %+v", cat.Errors)
	}
}
